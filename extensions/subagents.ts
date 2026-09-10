import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentManager } from "./subagent/agent-manager.ts";
import { loadConfig, ORCHESTRATION_TOOLS } from "./subagent/config.ts";
import { SubagentCoordinator, type Completion } from "./subagent/coordinator.ts";
import { delegationGuidance } from "./subagent/guidance.ts";
import { showUnifiedSubagentSettings } from "./subagent/settings-ui.ts";
import { selectDispatchModel } from "./subagent/model-selection.ts";
import { InlineAgentStore } from "./subagent/inline-store.ts";
import { renderInlineCall, renderInlineResult, type InlineAction, type InlineDetails } from "./subagent/inline-rendering.ts";
import { InteractionGate } from "./subagent/interaction-gate.ts";
import { showAgentsView } from "./subagent/agents-view.ts";
import type { LoadedConfig, ParentDispatchDefaults, SubagentConfig, ThinkingLevel } from "./subagent/types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OWNERSHIP_MESSAGE = "pi-simple-subagent:ownership";
const COMPLETION_MESSAGE = "pi-simple-subagent:completion";
const SpawnParams = Type.Object({
	task_name: Type.String({ minLength: 1, maxLength: 64, description: "Unique lowercase task name using letters, digits and underscores." }),
	message: Type.String({ minLength: 1, description: "Bounded, self-contained task, expected deliverable, and necessary context." }),
	agent_type: Type.Optional(Type.String({ description: "Choose from Available subagent profiles. Omit, empty, or whitespace uses defaultProfile." })),
	write_scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned files/directories or trailing /** scopes relative to child cwd. Required for worker. Parallel scopes must be disjoint." })),
	model: Type.Optional(Type.String({ description: "Normally omit. An explicit user-configured profile/root model takes precedence over this argument. Only used when both are inherit/unset." })),
	reasoning_effort: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Optional reasoning effort override; normally omit." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional child tool allowlist. Empty disables all tools." })),
	cwd: Type.Optional(Type.String({ description: "Optional child working directory relative to parent cwd, or absolute." })),
});
function parentDefaults(pi: ExtensionAPI, ctx: ExtensionContext, config: SubagentConfig): ParentDispatchDefaults {
	const excluded = new Set([...ORCHESTRATION_TOOLS, ...config.process.excludeTools]);
	return { cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, effort: ctx.thinkingLevel,
		tools: pi.getActiveTools().filter((name) => !excluded.has(name)), projectTrusted: ctx.isProjectTrusted() };
}
function result(value: unknown, details: InlineDetails, isError = false) {
	return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details, isError };
}

export default function simpleSubagentExtension(pi: ExtensionAPI): void {
	if (process.env.PI_SIMPLE_SUBAGENT_CHILD === "1") return;
	let loaded: LoadedConfig | undefined;
	let manager: AgentManager | undefined;
	let coordinator: SubagentCoordinator | undefined;
	let store = new InlineAgentStore();
	let gate = new InteractionGate();
	let lifetime = new AbortController();
	let unsubscribeUI: (() => void) | undefined;
	let epoch = 0, shutdown = false;
	let queuedCompletions: Completion[] = [];
	const shownDiagnostics = new Set<string>();
	function publish(results: Completion[]): void {
		pi.sendMessage({ customType: COMPLETION_MESSAGE, display: false,
			content: JSON.stringify({ type: "subagent_completion", results, instruction: "Review and integrate these results. Use the newest round if an agent has multiple results. Do not repeat child tasks or print raw child transcripts." }),
		}, { deliverAs: "steer", triggerTurn: true });
	}
	function flushCompletions(): void {
		if (shutdown || gate.isOpen || !queuedCompletions.length) return;
		publish(queuedCompletions); queuedCompletions = [];
	}
	async function ensure(ctx: ExtensionContext) {
		const token = epoch;
		const next = await loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		if (shutdown || token !== epoch) throw new Error("Session changed while loading subagent configuration.");
		loaded = next;
		if (manager) manager.setConfig(next.config);
		else {
			manager = new AgentManager(next.config);
			coordinator = new SubagentCoordinator(manager, (results) => {
				if (shutdown || token !== epoch) return;
				if (gate.isOpen) queuedCompletions.push(...results);
				else { flushCompletions(); publish(results); }
			});
			unsubscribeUI = manager.subscribe((snapshot) => store.accept(snapshot));
		}
		for (const diagnostic of next.diagnostics) {
			const key = `${diagnostic.path}\0${diagnostic.message}`;
			if (shownDiagnostics.has(key)) continue; shownDiagnostics.add(key);
			ctx.ui.notify(`${diagnostic.path}: ${diagnostic.message}`, diagnostic.severity === "error" ? "error" : "warning");
		}
		return { manager, coordinator: coordinator!, config: next.config, gate, store };
	}
	async function teardown() {
		shutdown = true; epoch++; lifetime.abort(); gate.dispose(); queuedCompletions = [];
		unsubscribeUI?.(); unsubscribeUI = undefined; store.dispose();
		const oldCoordinator = coordinator, oldManager = manager;
		coordinator = undefined; manager = undefined; loaded = undefined;
		await oldCoordinator?.dispose(); await oldManager?.shutdown();
	}
	async function start(ctx: ExtensionContext) {
		await teardown(); shutdown = false; lifetime = new AbortController(); gate = new InteractionGate(); store = new InlineAgentStore(); await ensure(ctx);
	}
	function details(action: InlineAction, targets?: string[]): InlineDetails {
		const agents = store.all().filter((agent) => targets ? targets.some((target) => target === agent.id || target === agent.taskName) : agent.status !== "closed");
		return { action, agents };
	}
	async function run(ctx: ExtensionContext, signal: AbortSignal | undefined, action: InlineAction, targets: string[] | undefined,
		operation: (current: Awaited<ReturnType<typeof ensure>>) => Promise<unknown> | unknown) {
		const token = epoch;
		let current: Awaited<ReturnType<typeof ensure>> | undefined;
		try {
			await gate.wait(signal); current = await ensure(ctx); flushCompletions();
			const value = await operation(current);
			await current.gate.wait(signal);
			if (token !== epoch || shutdown) throw new Error("Parent session changed.");
			const display = details(action, targets);
			if (value && typeof value === "object" && "timed_out" in value) display.timedOut = value.timed_out === true;
			return result(value, display);
		} catch (error) {
			if (signal?.aborted && token === epoch) await current?.coordinator.cancel();
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action, agents: [], message }, true);
		}
	}
	function renderers(action: InlineAction) {
		return { renderShell: "self" as const,
			renderCall(args: Record<string, unknown>, theme: Theme) { return renderInlineCall(action, args, theme); },
			renderResult(value: { details?: InlineDetails }, options: { isPartial: boolean }, theme: Theme, context: ToolRenderContext) {
				return renderInlineResult(value.details, options.isPartial, theme, store, context);
			} };
	}
	pi.on("session_start", async (_event, ctx) => { await start(ctx); });
	pi.on("session_shutdown", teardown);
	pi.on("session_tree", async (_event, ctx) => { await start(ctx); });
	pi.on("before_agent_start", async (event, ctx) => {
		const current = await ensure(ctx); flushCompletions();
		const models = Object.fromEntries(Object.keys(current.config.profiles).sort().map((name) => [name, selectDispatchModel(current.config, name).model ?? "inherit"]));
		return { systemPrompt: `${event.systemPrompt}\n\n${delegationGuidance(current.config)}\nUser-configured child models: ${JSON.stringify(models)}. Explicit profile/root model settings override model-authored spawn_agent.model arguments. Omit model unless the configuration inherits it. Existing agents keep the model selected when they were spawned.` };
	});
	pi.on("context", (event) => {
		const content = coordinator?.ownershipContext();
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === OWNERSHIP_MESSAGE));
		return content ? { messages: [...messages, { role: "custom" as const, customType: OWNERSHIP_MESSAGE, content, display: false, timestamp: 0 }] } : { messages };
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			await gate.wait();
			const reason = coordinator?.checkParentWrite(event.toolCallId, event.toolName, event.input, ctx.cwd);
			if (reason) return { block: true, reason };
		} catch (error) { return { block: true, reason: `Parent tool paused or delegated scope unavailable: ${String(error)}` }; }
	});
	pi.on("tool_execution_end", (event) => { coordinator?.finishParentWrite(event.toolCallId); });
	pi.on("agent_end", async (event) => {
		const last = event.messages.findLast((message) => message.role === "assistant");
		if (last?.stopReason === "aborted") { queuedCompletions = []; await coordinator?.cancel(); }
	});
	pi.registerCommand("subagent-config", {
		description: "Configure child model, reasoning effort, tools, and save scope in one TUI",
		handler: async (_args, ctx) => {
			const current = await ensure(ctx); const saved = await showUnifiedSubagentSettings(pi, ctx, current.config); if (!saved) return;
			loaded = loaded ? { ...loaded, config: saved.config } : loaded; manager?.setConfig(saved.config);
			ctx.ui.notify(`Saved subagent quick settings to ${saved.path}. Changes apply to newly spawned agents.`, "info");
			if (loaded?.explicitPath && saved.scope !== "explicit") ctx.ui.notify(`PI_SIMPLE_SUBAGENT_CONFIG is set; ${loaded.explicitPath} remains the highest-priority configuration source.`, "warning");
		},
	});
	pi.registerCommand("agents", {
		description: "Open a live subagent context and send prompts; optional agent ID or task name",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("/agents requires an interactive TUI.", "warning"); return; }
			const current = await ensure(ctx); let release: (() => void) | undefined;
			const token = epoch;
			try {
				release = current.gate.enter();
				await showAgentsView(ctx, current.manager, (target, text, interrupt) => current.coordinator.sendInput(target, text, interrupt, lifetime.signal), args, lifetime.signal);
			} catch (error) { if (token === epoch) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			finally {
				release?.();
				if (token === epoch) { try { flushCompletions(); } catch { ctx.ui.notify("Completion delivery is pending; it will be retried at the next parent entry point.", "warning"); } }
			}
		},
	});
	pi.registerTool({ name: "spawn_agent", label: "Spawn agent", ...renderers("spawn"),
		description: "Delegate an independent bounded task to a background pi RPC child. User-configured model settings take precedence. Do not repeat delegated work; continue non-overlapping work or wait_agent once. Results arrive automatically.",
		promptSnippet: "Delegate an independent bounded task to a background subagent",
		promptGuidelines: ["For spawn_agent, never repeat a delegated task while its owner runs.", "Provide disjoint write_scope for spawn_agent implementation workers.", "Omit spawn_agent model, reasoning_effort and tools unless needed; explicit model configuration wins."],
		parameters: SpawnParams,
		async execute(_id, params, signal, _update, ctx) {
			return run(ctx, signal, "spawn", [params.task_name.trim().toLowerCase()], async (current) => {
				const parent = parentDefaults(pi, ctx, current.config);
				const choice = selectDispatchModel(current.config, params.agent_type, params.model, parent.model);
				const snapshot = await current.coordinator.spawn({ taskName: params.task_name, message: params.message, profileName: params.agent_type,
					writeScope: params.write_scope, model: choice.model, effort: params.reasoning_effort as ThinkingLevel | undefined,
					tools: params.tools ? params.tools.length ? params.tools : "none" : undefined, cwd: params.cwd }, parent, signal);
				return { agent_id: snapshot.id, nickname: snapshot.taskName, agent_type: snapshot.profileName, status: snapshot.status,
					requested_model: choice.model, model: snapshot.model, model_source: choice.source, ignored_model_override: choice.ignoredOverride,
					ownership: current.coordinator.list().find((item) => item.agent_id === snapshot.id), instruction: "Task delegated. Do not repeat it. Continue independent work or wait_agent once." };
			});
		},
	});
	pi.registerTool({ name: "send_input", label: "Message agent", ...renderers("send"),
		description: "Refine an existing child task. Completed agents retain context. interrupt=true steers a running turn; otherwise queue a follow-up. Original write scope and model still apply.",
		parameters: Type.Object({ target: Type.String(), message: Type.String({ minLength: 1 }), interrupt: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal, _update, ctx) {
			return run(ctx, signal, "send", [params.target], async ({ coordinator }) => {
				const sent = await coordinator.sendInput(params.target, params.message, params.interrupt ?? false, signal);
				return { submission_id: sent.submissionId, agent_id: sent.snapshot.id, status: sent.snapshot.status, model: sent.snapshot.model };
			});
		},
	});
	pi.registerTool({ name: "wait_agent", label: "Wait for agent", ...renderers("wait"),
		description: "Wait for a new, not-yet-delivered child result. Omit timeout_ms or use 0 to wait until completion/cancellation. Do not poll. Delivered results do not unblock waits for running agents. Timeout never transfers task ownership.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1 }), timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_id, params, signal, update, ctx) {
			return run(ctx, signal, "wait", params.ids, async ({ coordinator }) => {
				update?.({ content: [{ type: "text", text: "Waiting for subagents…" }], details: details("wait", params.ids) });
				return coordinator.wait(params.ids, params.timeout_ms, signal);
			});
		},
	});
	pi.registerTool({ name: "close_agent", label: "Close agent", ...renderers("close"),
		description: "Close a child before explicit takeover or to release its slot. Completed agents remain reusable until closed. This does not retrieve results.",
		parameters: Type.Object({ target: Type.String() }),
		async execute(_id, params, signal, _update, ctx) { return run(ctx, signal, "close", [params.target], ({ coordinator }) => coordinator.close(params.target)); },
	});
	pi.registerTool({ name: "list_agents", label: "List agents", ...renderers("list"),
		description: "Diagnostic child status and ownership metadata only. No result bodies. Do not use for polling; completions arrive automatically or via wait_agent.", parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) { return run(ctx, signal, "list", undefined, ({ coordinator }) => ({ agents: coordinator.list() })); },
	});
}
