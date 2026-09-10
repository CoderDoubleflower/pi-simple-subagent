import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcProcess, type ChildEvent } from "./rpc-process.ts";
import { verifyRpcModel } from "./rpc-model.ts";
import { byteTruncate, emptyUsage, extractText, readUsage, toolSummary } from "./process-formatting.ts";
import type { AgentSnapshot, AgentStatus, ResolvedAgentSettings, SubagentConfig } from "./types.ts";
export { byteTruncate } from "./process-formatting.ts";
export type { ChildEvent } from "./rpc-process.ts";
export interface AgentProcessOptions { id: string; taskName: string; message: string; settings: ResolvedAgentSettings; config: SubagentConfig }
const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class AgentProcess {
	private readonly options: AgentProcessOptions;
	private readonly listeners = new Set<(snapshot: AgentSnapshot) => void>();
	private readonly eventListeners = new Set<(event: ChildEvent) => void>();
	private rpc?: RpcProcess;
	private promptTempDir?: string;
	private snapshotValue: AgentSnapshot;
	private lastStopReason?: string;
	private verifiedModel?: string;
	private closing = false;
	private closePromise?: Promise<void>;
	constructor(options: AgentProcessOptions) {
		this.options = options;
		const now = Date.now();
		this.snapshotValue = { id: options.id, taskName: options.taskName, profileName: options.settings.profileName,
			profileDescription: options.settings.profileDescription, message: options.message, status: "starting", finalOutput: "", stderr: "",
			model: options.settings.model, effort: options.settings.effort,
			tools: Array.isArray(options.settings.tools) ? [...options.settings.tools] : options.settings.tools, cwd: options.settings.cwd,
			usage: emptyUsage(), activities: [], startedAt: now, updatedAt: now, display: { ...options.config.output } };
	}
	get snapshot(): AgentSnapshot { return structuredClone(this.snapshotValue); }
	subscribe(listener: (snapshot: AgentSnapshot) => void): () => void {
		this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener); };
	}
	/** Only the explicit /agents view subscribes to private child message events. */
	subscribeEvents(listener: (event: ChildEvent) => void): () => void {
		this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); };
	}
	async getMessages(signal?: AbortSignal): Promise<unknown[]> {
		if (!this.rpc) throw new Error("Subagent RPC is unavailable.");
		const data = await this.rpc.request({ type: "get_messages" }, signal);
		if (!data || typeof data !== "object" || !Array.isArray((data as { messages?: unknown }).messages)) throw new Error("Child RPC returned an invalid conversation.");
		return (data as { messages: unknown[] }).messages;
	}
	private async verifyModel(signal?: AbortSignal): Promise<void> {
		this.verifiedModel = await verifyRpcModel((command, abort) => this.rpc!.request(command, abort), this.options.settings.model, this.options.settings.effort, signal);
		this.snapshotValue.model = this.verifiedModel; this.touch();
	}
	async start(signal?: AbortSignal): Promise<void> {
		if (this.rpc) throw new Error("Subagent process has already started.");
		const args = await this.buildArgs();
		if (this.closing || signal?.aborted) throw new Error("Subagent start aborted.");
		const p = this.options.config.process;
		const env: NodeJS.ProcessEnv = p.inheritEnvironment ? { ...process.env } : {};
		Object.assign(env, p.env, this.options.settings.env, { PI_SIMPLE_SUBAGENT_CHILD: "1" });
		this.rpc = new RpcProcess({ command: p.command, args, cwd: this.options.settings.cwd, env,
			timeoutMs: this.options.config.rpcStartupTimeoutMs, onEvent: (event) => this.handleEvent(event),
			onStderr: (text) => this.appendStderr(text), onExit: (message) => {
				if (!this.closing) { this.finishActivities(true); this.fail(new Error(message)); }
				void this.cleanupTempPrompt();
			} });
		try {
			await this.rpc.start(signal);
			await this.verifyModel(signal);
			this.setStatus("running");
			await this.rpc.request({ type: "prompt", message: this.options.message }, signal);
		} catch (error) { this.fail(error); throw error; }
	}
	async sendInput(message: string, interrupt: boolean, signal?: AbortSignal): Promise<string> {
		if (this.closing || this.snapshotValue.status === "closed") throw new Error(`Subagent ${this.options.id} is closed.`);
		if (!this.rpc?.alive) throw new Error(`Subagent ${this.options.id} is not running.`);
		const id = `submission_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const running = this.snapshotValue.status === "running" || this.snapshotValue.status === "starting";
		if (running) await this.rpc.request({ type: interrupt ? "steer" : "follow_up", message }, signal);
		else {
			const previous = this.snapshot, previousStop = this.lastStopReason;
			this.prepareForTurn();
			try { await this.verifyModel(signal); await this.rpc.request({ type: "prompt", message }, signal); }
			catch (error) { this.snapshotValue = previous; this.lastStopReason = previousStop; this.touch(); throw error; }
		}
		return id;
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			await this.rpc?.close(this.options.config.killGraceMs, this.options.config.killForceMs);
			this.finishActivities(true); this.setStatus("closed"); this.eventListeners.clear(); await this.cleanupTempPrompt();
		})();
		return this.closePromise;
	}
	private async buildArgs(): Promise<string[]> {
		const args = [...this.options.config.process.extraArgs, ...this.options.settings.extraArgs, "--mode", "rpc", "--no-session"];
		if (this.options.settings.model) args.push("--model", this.options.settings.model);
		if (this.options.settings.effort) args.push("--thinking", this.options.settings.effort);
		if (this.options.settings.tools === "none") args.push("--no-tools");
		else if (Array.isArray(this.options.settings.tools)) args.push("--tools", this.options.settings.tools.join(","));
		const excluded = [...new Set(this.options.config.process.excludeTools)];
		if (excluded.length) args.push("--exclude-tools", excluded.join(","));
		args.push(this.options.settings.approveProject ? "--approve" : "--no-approve");
		if (this.options.settings.systemPrompt.trim()) {
			this.promptTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-simple-subagent-"));
			const file = path.join(this.promptTempDir, "system-prompt.md");
			await fs.promises.writeFile(file, this.options.settings.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", file);
		}
		return args;
	}
	private handleEvent(event: ChildEvent): void {
		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			const method = typeof event.method === "string" ? event.method : "unknown";
			if (BLOCKING_UI_METHODS.has(method)) {
				this.appendStderr(`[extension_ui:${method}] auto-cancelled because the subagent has no interactive TUI.\n`);
				this.rpc?.write({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			return;
		}
		if (event.type === "agent_start") this.prepareForTurn();
		if (event.type === "tool_execution_start") {
			const name = String(event.toolName ?? event.name ?? "tool");
			this.snapshotValue.activities.push({ id: String(event.toolCallId ?? event.id ?? randomUUID()), kind: "tool", name,
				summary: toolSummary(name, event.args ?? event.arguments), status: "running", startedAt: Date.now() });
			const max = this.options.config.output.maxActivityItems;
			if (this.snapshotValue.activities.length > max) this.snapshotValue.activities.splice(0, this.snapshotValue.activities.length - max);
			this.touch();
		}
		if (event.type === "tool_execution_end") {
			const activity = this.snapshotValue.activities.findLast((item) => item.id === String(event.toolCallId ?? event.id ?? ""));
			if (activity) { activity.status = event.isError === true ? "errored" : "completed"; activity.endedAt = Date.now(); this.touch(); }
		}
		if (event.type === "message_end" && event.message && typeof event.message === "object") {
			const message = event.message as Record<string, unknown>;
			if (message.role === "assistant") {
				const text = extractText(message);
				if (text) this.snapshotValue.finalOutput = byteTruncate(text, this.options.config.output.maxFinalBytes);
				const usage = readUsage(message);
				if (usage) for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) this.snapshotValue.usage[key] += usage[key];
				if (typeof message.provider === "string" && typeof message.model === "string") {
					this.snapshotValue.model = `${message.provider}/${message.model}`;
					if (this.verifiedModel && this.snapshotValue.model !== this.verifiedModel) this.snapshotValue.error = `Child model changed after verification: expected ${this.verifiedModel}, received ${this.snapshotValue.model}. Check child extensions.`;
				}
				this.lastStopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
				if (message.stopReason === "error") this.snapshotValue.error = typeof message.errorMessage === "string" && message.errorMessage.trim() ? `Subagent turn error: ${message.errorMessage}` : "Subagent turn failed.";
				else if (message.stopReason === "aborted") this.snapshotValue.error = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : "Subagent turn was interrupted.";
				this.touch();
			}
		}
		if (event.type === "agent_settled" && !this.closing) {
			this.finishActivities(false); this.setStatus(this.lastStopReason === "aborted" ? "interrupted" : this.snapshotValue.error ? "errored" : "completed");
		}
		for (const listener of this.eventListeners) { try { listener(event); } catch { /* UI observers cannot interrupt child execution. */ } }
	}
	private prepareForTurn(): void {
		if (this.closing) return;
		this.snapshotValue.finalOutput = ""; this.snapshotValue.error = undefined; this.snapshotValue.completedAt = undefined;
		this.lastStopReason = undefined; this.setStatus("running");
	}
	private finishActivities(error: boolean): void {
		for (const item of this.snapshotValue.activities) if (item.status === "running") { item.status = error ? "errored" : "completed"; item.endedAt = Date.now(); }
		this.touch();
	}
	private fail(error: unknown): void { this.snapshotValue.error = error instanceof Error ? error.message : String(error); this.lastStopReason = "error"; this.setStatus("errored"); }
	private appendStderr(text: string): void {
		this.snapshotValue.stderr = byteTruncate(this.snapshotValue.stderr + text, this.options.config.output.maxStderrBytes, "\n[stderr truncated by pi-simple-subagent]"); this.touch();
	}
	private setStatus(status: AgentStatus): void {
		this.snapshotValue.status = status;
		if (["completed", "errored", "interrupted", "closed"].includes(status)) this.snapshotValue.completedAt ??= Date.now();
		this.touch();
	}
	private touch(): void { this.snapshotValue.updatedAt = Date.now(); const snapshot = this.snapshot; for (const listener of this.listeners) listener(snapshot); }
	private async cleanupTempPrompt(): Promise<void> {
		if (!this.promptTempDir) return;
		const dir = this.promptTempDir; this.promptTempDir = undefined; await fs.promises.rm(dir, { recursive: true, force: true });
	}
}
