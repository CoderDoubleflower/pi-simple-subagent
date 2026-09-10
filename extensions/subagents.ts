import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentManager } from "./subagent/agent-manager.ts";
import { loadConfig, ORCHESTRATION_TOOLS } from "./subagent/config.ts";
import { SubagentCoordinator } from "./subagent/coordinator.ts";
import { delegationGuidance } from "./subagent/guidance.ts";
import { installSubagentPanel } from "./subagent/panel.ts";
import { HIDDEN_TOOL_ROW } from "./subagent/rendering.ts";
import { showUnifiedSubagentSettings } from "./subagent/settings-ui.ts";
import type { LoadedConfig, ParentDispatchDefaults, SubagentConfig, ThinkingLevel } from "./subagent/types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OWNERSHIP_MESSAGE = "pi-simple-subagent:ownership";
const COMPLETION_MESSAGE = "pi-simple-subagent:completion";
const hidden = {
	renderShell: "self" as const,
	renderCall() { return HIDDEN_TOOL_ROW; },
	renderResult() { return HIDDEN_TOOL_ROW; },
};
const SpawnParams = Type.Object({
	task_name: Type.String({ minLength: 1, maxLength: 64, description: "Unique lowercase task name using letters, digits and underscores." }),
	message: Type.String({ minLength: 1, description: "Bounded, self-contained task, expected deliverable, and necessary context." }),
	agent_type: Type.Optional(Type.String({ description: "Choose from Available subagent profiles in the system prompt. Omit, empty, or whitespace means configured defaultProfile." })),
	write_scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned exact files/directories or trailing /** scopes, relative to child cwd. Required for worker. Parallel write scopes must be disjoint." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override; normally omit." })),
	reasoning_effort: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Optional reasoning effort override; normally omit." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional child tool allowlist. Empty disables all tools." })),
	cwd: Type.Optional(Type.String({ description: "Optional child working directory relative to parent cwd, or absolute." })),
});
function parentDefaults(pi: ExtensionAPI, ctx: ExtensionContext, config: SubagentConfig): ParentDispatchDefaults {
	const excluded = new Set([...ORCHESTRATION_TOOLS, ...config.process.excludeTools]);
	return { cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: ctx.thinkingLevel,
		tools: pi.getActiveTools().filter((name) => !excluded.has(name)), projectTrusted: ctx.isProjectTrusted() };
}
function result(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {}, isError };
}

export default function simpleSubagentExtension(pi: ExtensionAPI): void {
	if (process.env.PI_SIMPLE_SUBAGENT_CHILD === "1") return;
	let loaded: LoadedConfig | undefined;
	let manager: AgentManager | undefined;
	let coordinator: SubagentCoordinator | undefined;
	let panel: ReturnType<typeof installSubagentPanel> | undefined;
	let epoch = 0;
	let shutdown = false;
	const shownDiagnostics = new Set<string>();

	async function ensure(ctx: ExtensionContext) {
		const token = epoch;
		const next = await loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (shutdown || epoch !== token) throw new Error("Session changed while loading subagent configuration.");
		loaded = next;
		if (manager) manager.setConfig(next.config);
		else {
			manager = new AgentManager(next.config);
			coordinator = new SubagentCoordinator(manager, (results) => {
				if (shutdown || epoch !== token) return;
				pi.sendMessage({ customType: COMPLETION_MESSAGE, display: false,
					content: JSON.stringify({ type: "subagent_completion", results, instruction: "Use these results to review and integrate the delegated work. Do not repeat the child task or print its raw output." }),
				}, { deliverAs: "steer", triggerTurn: true });
			});
			panel = installSubagentPanel(pi, ctx, coordinator);
		}
		for (const diagnostic of next.diagnostics) {
			const key = `${diagnostic.path}\0${diagnostic.message}`;
			if (shownDiagnostics.has(key)) continue;
			shownDiagnostics.add(key);
			ctx.ui.notify(`${diagnostic.path}: ${diagnostic.message}`, diagnostic.severity === "error" ? "error" : "warning");
		}
		return { manager, coordinator: coordinator!, config: next.config };
	}
	async function teardown() {
		shutdown = true; epoch++;
		const oldCoordinator = coordinator;
		const oldManager = manager;
		coordinator = undefined; manager = undefined; loaded = undefined;
		panel?.dispose(); panel = undefined;
		await oldCoordinator?.dispose();
		await oldManager?.shutdown();
	}
	async function start(ctx: ExtensionContext) { await teardown(); shutdown = false; await ensure(ctx); }
	async function run(ctx: ExtensionContext, signal: AbortSignal | undefined, action: (current: Awaited<ReturnType<typeof ensure>>) => Promise<unknown> | unknown) {
		let current: Awaited<ReturnType<typeof ensure>> | undefined;
		try { current = await ensure(ctx); return result(await action(current)); }
		catch (error) {
			if (signal?.aborted) await current?.coordinator.cancel();
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	pi.on("session_start", async (_event, ctx) => { await start(ctx); });
	pi.on("session_shutdown", teardown);
	pi.on("session_tree", async (_event, ctx) => { await start(ctx); });
	pi.on("before_agent_start", async (event, ctx) => {
		const current = await ensure(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${delegationGuidance(current.config)}` };
	});
	pi.on("context", (event) => {
		const content = coordinator?.ownershipContext();
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === OWNERSHIP_MESSAGE));
		if (!content) return { messages };
		return { messages: [...messages, { role: "custom" as const, customType: OWNERSHIP_MESSAGE, content, display: false, timestamp: 0 }] };
	});
	pi.on("tool_call", (event, ctx) => {
		try {
			const reason = coordinator?.checkParentWrite(event.toolCallId, event.toolName, event.input, ctx.cwd);
			if (reason) return { block: true, reason };
		} catch (error) { return { block: true, reason: `Cannot validate delegated write scope: ${String(error)}` }; }
	});
	pi.on("tool_execution_end", (event) => { coordinator?.finishParentWrite(event.toolCallId); });
	pi.on("agent_end", async (event) => {
		const last = event.messages.findLast((message) => message.role === "assistant");
		if (last?.stopReason === "aborted") await coordinator?.cancel();
	});

	pi.registerCommand("subagent-config", {
		description: "Configure child model, reasoning effort, tools, and save scope in one TUI",
		handler: async (_args, ctx) => {
			const current = await ensure(ctx);
			const saved = await showUnifiedSubagentSettings(pi, ctx, current.config);
			if (!saved) return;
			loaded = loaded ? { ...loaded, config: saved.config } : loaded;
			manager?.setConfig(saved.config);
			ctx.ui.notify(`Saved subagent quick settings to ${saved.path}`, "info");
			if (loaded?.explicitPath && saved.scope !== "explicit") ctx.ui.notify(`PI_SIMPLE_SUBAGENT_CONFIG is set; ${loaded.explicitPath} remains the highest-priority configuration source.`, "warning");
		},
	});
	pi.registerTool({
		name: "spawn_agent", label: "Spawn agent", ...hidden,
		description: "Delegate a bounded independent task to a background pi --mode rpc --no-session child. Ownership transfers to the child until completion/close. Results arrive automatically; do only non-overlapping work, otherwise wait_agent once. Choose agent_type from the available profiles in the system prompt.",
		promptSnippet: "Delegate an independent bounded task to a background subagent",
		promptGuidelines: ["Never repeat a delegated task while its owner runs.", "Provide disjoint write_scope for implementation workers.", "Omit model, reasoning_effort and tools unless an override is necessary."],
		parameters: SpawnParams,
		async execute(_id, params, signal, _update, ctx) {
			return run(ctx, signal, async (current) => {
				const snapshot = await current.coordinator.spawn({ taskName: params.task_name, message: params.message,
					profileName: params.agent_type, writeScope: params.write_scope, model: params.model,
					effort: params.reasoning_effort as ThinkingLevel | undefined, tools: params.tools ? (params.tools.length ? params.tools : "none") : undefined, cwd: params.cwd,
				}, parentDefaults(pi, ctx, current.config), signal);
				return { agent_id: snapshot.id, nickname: snapshot.taskName, agent_type: snapshot.profileName, status: snapshot.status,
					ownership: current.coordinator.list().find((item) => item.agent_id === snapshot.id),
					instruction: "Task delegated. Do not repeat it. Continue independent work or wait_agent once; results are delivered automatically when not claimed by a wait." };
			});
		},
	});
	pi.registerTool({
		name: "send_input", label: "Message agent", ...hidden,
		description: "Refine an existing subagent task. Completed agents keep context for another round. interrupt=true steers a running turn; otherwise queue a follow-up. The original write scope still applies.",
		parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1 }), interrupt: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal, _update, ctx) {
			return run(ctx, signal, async ({ coordinator }) => {
				const sent = await coordinator.sendInput(params.target, params.message, params.interrupt ?? false, signal);
				return { submission_id: sent.submissionId, agent_id: sent.snapshot.id, status: sent.snapshot.status };
			});
		},
	});
	pi.registerTool({
		name: "wait_agent", label: "Wait for agent", ...hidden,
		description: "Wait for a new, not-yet-delivered result from any requested agent. Omit timeout_ms (or use 0) to wait until completion/cancellation. Positive deadlines are bounded and at least 1000ms. Do not poll. Already-delivered results do not unblock waits for running agents. Timeout never transfers task ownership.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }), timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_id, params, signal, _update, ctx) { return run(ctx, signal, ({ coordinator }) => coordinator.wait(params.ids, params.timeout_ms, signal)); },
	});
	pi.registerTool({
		name: "close_agent", label: "Close agent", ...hidden,
		description: "Close an agent before an explicit task takeover or to release its concurrency slot. Completed agents remain reusable until closed. This does not retrieve results.",
		parameters: Type.Object({ target: Type.String() }),
		async execute(_id, params, signal, _update, ctx) { return run(ctx, signal, ({ coordinator }) => coordinator.close(params.target)); },
	});
	pi.registerTool({
		name: "list_agents", label: "List agents", ...hidden,
		description: "Diagnostic status/ownership metadata only. No result bodies. Do not use for progress polling; completions arrive automatically or through wait_agent.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) { return run(ctx, signal, ({ coordinator }) => ({ agents: coordinator.list() })); },
	});
}
