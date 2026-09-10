import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { AgentProcess } from "./agent-process.ts";
import { resolveProfileName } from "./guidance.ts";
import type {
	AgentSnapshot, CloseResult, ParentDispatchDefaults, ResolvedAgentSettings, ResolvedToolSelection,
	SpawnAgentRequest, SubagentConfig, ThinkingLevel, ToolSelection, WaitResult,
} from "./types.ts";

const TERMINAL_STATUSES = new Set(["completed", "errored", "interrupted", "closed"]);
function isTerminal(snapshot: AgentSnapshot): boolean { return TERMINAL_STATUSES.has(snapshot.status); }
function uniqueTaskName(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_]{0,63}$/.test(normalized)) {
		throw new Error("task_name must contain lowercase letters, digits, and underscores, start with a letter or digit, and be at most 64 characters.");
	}
	return normalized;
}
function nonEmptyTask(value: string): string {
	const task = value.trim();
	if (!task) throw new Error("Subagent message must not be empty.");
	return task;
}
function resolveModel(override: string | undefined, profile: string | undefined, root: string, parent: string | undefined): string | undefined {
	for (const value of [override, profile, root, parent]) {
		if (typeof value === "string" && value !== "inherit" && value.trim()) return value.trim();
	}
	return undefined;
}
function resolveEffort(override: ThinkingLevel | undefined, profile: ThinkingLevel | "inherit" | undefined, root: ThinkingLevel | "inherit", parent: ThinkingLevel | undefined): ThinkingLevel | undefined {
	for (const value of [override, profile, root, parent]) if (value && value !== "inherit") return value;
	return undefined;
}
function normalizeResolvedTools(value: string[] | "none"): ResolvedToolSelection {
	if (value === "none") return "none";
	const tools = [...new Set(value.map((tool) => tool.trim()).filter(Boolean))];
	return tools.length > 0 ? tools : "none";
}
function resolveTools(override: string[] | "none" | undefined, profile: ToolSelection | undefined, root: ToolSelection, parent: string[]): ResolvedToolSelection {
	if (override !== undefined) return normalizeResolvedTools(override);
	if (profile !== undefined && profile !== "inherit") return normalizeResolvedTools(profile);
	if (root !== "inherit") return normalizeResolvedTools(root);
	return normalizeResolvedTools(parent);
}
function abortError(): Error {
	const error = new Error("wait_agent was aborted.");
	error.name = "AbortError";
	return error;
}

export class AgentManager {
	private configValue: SubagentConfig;
	private readonly agents = new Map<string, AgentProcess>();
	private readonly listeners = new Set<(snapshot: AgentSnapshot) => void>();
	private readonly subscriptions = new Map<string, () => void>();
	constructor(config: SubagentConfig) { this.configValue = config; }
	get config(): SubagentConfig { return this.configValue; }
	setConfig(config: SubagentConfig): void { this.configValue = config; }

	/** One aggregate event source for the UI and completion delivery, independent of model waits. */
	subscribe(listener: (snapshot: AgentSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	async spawn(request: SpawnAgentRequest, parent: ParentDispatchDefaults, signal?: AbortSignal): Promise<AgentSnapshot> {
		const activeCount = [...this.agents.values()].filter((agent) => agent.snapshot.status !== "closed").length;
		if (activeCount >= this.configValue.maxAgents) throw new Error(`Subagent limit reached (${this.configValue.maxAgents}). Close an existing agent before spawning another.`);
		const taskName = uniqueTaskName(request.taskName);
		if (this.find(taskName)) throw new Error(`A subagent named "${taskName}" already exists.`);
		const message = nonEmptyTask(request.message);
		const settings = this.resolveSettings({ ...request, taskName, message }, parent);
		const id = `agent_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const agent = new AgentProcess({ id, taskName, message, settings, config: this.configValue });
		this.agents.set(id, agent);
		this.subscriptions.set(id, agent.subscribe((snapshot) => {
			for (const listener of this.listeners) listener(snapshot);
		}));
		try {
			await agent.start(signal);
			return agent.snapshot;
		} catch (error) {
			this.agents.delete(id);
			this.subscriptions.get(id)?.();
			this.subscriptions.delete(id);
			await agent.close().catch(() => undefined);
			throw error;
		}
	}

	async sendInput(target: string, message: string, interrupt: boolean, signal?: AbortSignal): Promise<{ submissionId: string; snapshot: AgentSnapshot }> {
		const agent = this.require(target);
		const submissionId = await agent.sendInput(nonEmptyTask(message), interrupt, signal);
		return { submissionId, snapshot: agent.snapshot };
	}

	/** Low-level bounded wait retained for integrations. The model-facing coordinator uses event-driven waits. */
	async wait(targets: string[], timeoutMs: number | undefined, signal?: AbortSignal, onUpdate?: (snapshots: AgentSnapshot[]) => void): Promise<WaitResult> {
		const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
		if (uniqueTargets.length === 0) throw new Error("wait_agent requires at least one non-empty target.");
		const found = uniqueTargets.map((target) => ({ target, agent: this.find(target) }));
		const live = found.flatMap((item) => (item.agent ? [item.agent] : []));
		const requestedTimeout = timeoutMs ?? this.configValue.defaultWaitTimeoutMs;
		const effectiveTimeout = Math.max(0, Math.min(requestedTimeout, this.configValue.maxWaitTimeoutMs));
		const emit = () => onUpdate?.(live.map((agent) => agent.snapshot));
		emit();
		if (signal?.aborted) throw abortError();
		if (live.length > 0 && !live.some((agent) => isTerminal(agent.snapshot)) && effectiveTimeout > 0) {
			await new Promise<void>((resolve, reject) => {
				let done = false;
				const unsubscribers: Array<() => void> = [];
				const finish = (error?: Error) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					for (const unsubscribe of unsubscribers) unsubscribe();
					if (error) reject(error); else resolve();
				};
				const onAbort = () => finish(abortError());
				const timer = setTimeout(() => finish(), effectiveTimeout);
				for (const agent of live) {
					const unsubscribe = agent.subscribe(() => {
						emit();
						if (live.some((candidate) => isTerminal(candidate.snapshot))) finish();
					});
					unsubscribers.push(unsubscribe);
					if (done) unsubscribe();
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
		}
		const status: WaitResult["status"] = {};
		for (const item of found) status[item.target] = item.agent ? item.agent.snapshot : { status: "not_found" };
		return { status, timedOut: live.length > 0 && !live.some((agent) => isTerminal(agent.snapshot)) };
	}

	async close(target: string): Promise<CloseResult> {
		const agent = this.find(target.trim());
		if (!agent) return { previousSnapshot: { status: "not_found" } };
		const previousSnapshot = agent.snapshot;
		await agent.close();
		const snapshot = agent.snapshot;
		this.subscriptions.get(snapshot.id)?.();
		this.subscriptions.delete(snapshot.id);
		this.agents.delete(snapshot.id);
		return { previousSnapshot, snapshot };
	}
	list(): AgentSnapshot[] {
		return [...this.agents.values()].map((agent) => agent.snapshot).sort((a, b) => a.startedAt - b.startedAt);
	}
	async shutdown(): Promise<void> {
		await Promise.allSettled([...this.agents.values()].map((agent) => agent.close()));
		for (const unsubscribe of this.subscriptions.values()) unsubscribe();
		this.subscriptions.clear();
		this.agents.clear();
		this.listeners.clear();
	}
	private find(target: string): AgentProcess | undefined {
		return this.agents.get(target) ?? [...this.agents.values()].find((agent) => agent.snapshot.taskName === target);
	}
	private require(target: string): AgentProcess {
		const agent = this.find(target.trim());
		if (!agent) throw new Error(`Unknown subagent: ${target}`);
		return agent;
	}
	private resolveSettings(request: SpawnAgentRequest, parent: ParentDispatchDefaults): ResolvedAgentSettings {
		const profileName = resolveProfileName(request.profileName, this.configValue);
		const profile = this.configValue.profiles[profileName];
		const model = resolveModel(request.model, profile.model, this.configValue.model, parent.model);
		const effort = resolveEffort(request.effort, profile.effort, this.configValue.effort, parent.effort);
		const selectedTools = resolveTools(request.tools, profile.tools, this.configValue.tools, parent.tools);
		const excludedTools = new Set(this.configValue.process.excludeTools);
		const tools = selectedTools === "none" ? "none" : normalizeResolvedTools(selectedTools.filter((tool) => !excludedTools.has(tool)));
		const cwdValue = request.cwd ?? profile.cwd ?? parent.cwd;
		const cwd = path.isAbsolute(cwdValue) ? path.normalize(cwdValue) : path.resolve(parent.cwd, cwdValue);
		const approveProject = this.configValue.process.approveProject === "always" ? true : this.configValue.process.approveProject === "never" ? false : parent.projectTrusted;
		const basePrompt = [
			`You are subagent "${request.taskName}" working for a parent coding agent.`,
			"Complete only the delegated task. Keep the result concise, evidence-based, and directly usable by the parent agent.",
			profile.systemPrompt ?? "",
		].filter(Boolean).join("\n\n");
		return { profileName, profileDescription: profile.description, systemPrompt: basePrompt, model, effort, tools, cwd,
			extraArgs: [...(profile.extraArgs ?? [])], env: { ...(profile.env ?? {}) }, approveProject };
	}
}
