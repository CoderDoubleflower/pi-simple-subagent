import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentManager } from "./subagent/agent-manager.ts";
import { loadConfig, ORCHESTRATION_TOOLS } from "./subagent/config.ts";
import { renderSubagentCall, renderSubagentResult } from "./subagent/rendering.ts";
import { showUnifiedSubagentSettings } from "./subagent/settings-ui.ts";
import type {
	AgentSnapshot,
	AgentToolDetails,
	AgentWireStatus,
	LoadedConfig,
	ParentDispatchDefaults,
	SubagentConfig,
	ThinkingLevel,
} from "./subagent/types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const SpawnParams = Type.Object({
	task_name: Type.String({
		description: "Short task name using lowercase letters, digits, and underscores, for example inspect_api.",
		minLength: 1,
		maxLength: 64,
	}),
	message: Type.String({ description: "Concrete, bounded, self-contained task for the new subagent." }),
	agent_type: Type.Optional(Type.String({ description: "Configured subagent profile. Omit to use defaultProfile." })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override. Omit to inherit configured defaults." })),
	reasoning_effort: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Optional reasoning effort override." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional child tool allowlist. An empty array disables all tools." })),
	cwd: Type.Optional(Type.String({ description: "Optional child working directory, absolute or relative to the parent cwd." })),
});

const SendInputParams = Type.Object({
	target: Type.String({ description: "Agent id or task_name returned by spawn_agent." }),
	message: Type.String({ description: "Follow-up instruction for the existing subagent." }),
	interrupt: Type.Optional(
		Type.Boolean({ description: "Interrupt and redirect a running turn. Defaults to false, which queues a follow-up." }),
	),
});

const WaitParams = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, description: "Agent ids or task names to wait for." }),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Wait timeout in milliseconds. The configured maximum is enforced." })),
});

const CloseParams = Type.Object({
	target: Type.String({ description: "Agent id or task_name to close." }),
});

const ListParams = Type.Object({});

function parentDefaults(pi: ExtensionAPI, ctx: ExtensionContext, config: SubagentConfig): ParentDispatchDefaults {
	const excluded = new Set([...ORCHESTRATION_TOOLS, ...config.process.excludeTools]);
	return {
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		effort: ctx.thinkingLevel,
		tools: pi.getActiveTools().filter((name) => !excluded.has(name)),
		projectTrusted: ctx.isProjectTrusted(),
	};
}

function wireStatus(snapshot: AgentSnapshot): AgentWireStatus {
	switch (snapshot.status) {
		case "starting":
			return "starting";
		case "running":
			return "running";
		case "completed":
			return { completed: snapshot.finalOutput };
		case "errored":
			return { errored: snapshot.error || snapshot.finalOutput || "Subagent failed without an error message." };
		case "interrupted":
			return "interrupted";
		case "closed":
			return "shutdown";
	}
}

function listSummary(snapshot: AgentSnapshot): Record<string, unknown> {
	return {
		agent_id: snapshot.id,
		agent_name: snapshot.taskName,
		agent_type: snapshot.profileName,
		agent_status: wireStatus(snapshot),
		model: snapshot.model,
		reasoning_effort: snapshot.effort,
		tool_uses: snapshot.activities.filter((item) => item.kind === "tool").length,
	};
}

function textResult(text: string, details: AgentToolDetails, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

export default function simpleSubagentExtension(pi: ExtensionAPI): void {
	if (process.env.PI_SIMPLE_SUBAGENT_CHILD === "1") return;

	let loaded: LoadedConfig | undefined;
	let manager: AgentManager | undefined;
	const shownDiagnostics = new Set<string>();

	async function ensureManager(ctx: ExtensionContext): Promise<{ manager: AgentManager; config: SubagentConfig }> {
		// Config files are deliberately re-read on every user/tool entry point. They
		// are tiny, and this makes manual JSON edits take effect without /reload.
		const next = await loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		loaded = next;
		if (manager) manager.setConfig(next.config);
		else manager = new AgentManager(next.config);
		for (const diagnostic of next.diagnostics) {
			const key = `${diagnostic.path}\0${diagnostic.message}`;
			if (shownDiagnostics.has(key)) continue;
			shownDiagnostics.add(key);
			ctx.ui.notify(
				`${diagnostic.path}: ${diagnostic.message}`,
				diagnostic.severity === "error" ? "error" : "warning",
			);
		}
		return { manager, config: next.config };
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureManager(ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager?.shutdown();
	});

	pi.registerCommand("subagent-config", {
		description: "Configure child model, reasoning effort, tools, and save scope in one TUI",
		handler: async (_args, ctx) => {
			const current = await ensureManager(ctx);
			const saved = await showUnifiedSubagentSettings(pi, ctx, current.config);
			if (!saved) return;
			loaded = loaded ? { ...loaded, config: saved.config } : loaded;
			manager?.setConfig(saved.config);
			ctx.ui.notify(`Saved subagent quick settings to ${saved.path}`, "info");
			if (loaded?.explicitPath && saved.scope !== "explicit") {
				ctx.ui.notify(
					`PI_SIMPLE_SUBAGENT_CONFIG is set; ${loaded.explicitPath} remains the highest-priority configuration source.`,
					"warning",
				);
			}
		},
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn agent",
		description:
			"Spawn a background subagent for one concrete, bounded task. The child runs as pi --mode rpc --no-session, inherits configured model/effort/tools by default, and returns immediately with an id. Continue useful non-overlapping work, then call wait_agent only when the result is needed.",
		promptSnippet: "Delegate an independent bounded task to a background subagent",
		promptGuidelines: [
			"Delegate only self-contained work that can run independently; do not delegate the immediate critical-path action.",
			"Use distinct task_name values and disjoint write scopes for parallel workers.",
			"Omit model, reasoning_effort, and tools unless a task genuinely needs an override.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const current = await ensureManager(ctx);
				const snapshot = await current.manager.spawn(
					{
						taskName: params.task_name,
						message: params.message,
						profileName: params.agent_type,
						model: params.model,
						effort: params.reasoning_effort as ThinkingLevel | undefined,
						tools: params.tools ? (params.tools.length ? params.tools : "none") : undefined,
						cwd: params.cwd,
					},
					parentDefaults(pi, ctx, current.config),
					signal,
				);
				const details: AgentToolDetails = { action: "spawn", snapshots: [snapshot] };
				return textResult(JSON.stringify({ agent_id: snapshot.id, nickname: snapshot.taskName }), details);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { action: "spawn", snapshots: [], message }, true);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall("spawn", args as Record<string, unknown>, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderSubagentResult(result.details as AgentToolDetails | undefined, expanded, theme, isPartial);
		},
	});

	pi.registerTool({
		name: "send_input",
		label: "Message agent",
		description:
			"Send a follow-up instruction to an existing subagent. A completed agent keeps its context and starts another turn. For a running agent, interrupt=true redirects it; otherwise the message is queued as a follow-up.",
		parameters: SendInputParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const current = await ensureManager(ctx);
				const result = await current.manager.sendInput(params.target, params.message, params.interrupt ?? false, signal);
				const details: AgentToolDetails = { action: "send", snapshots: [result.snapshot] };
				return textResult(JSON.stringify({ submission_id: result.submissionId }), details);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { action: "send", snapshots: [], message }, true);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall("send", args as Record<string, unknown>, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderSubagentResult(result.details as AgentToolDetails | undefined, expanded, theme, isPartial);
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait for agent",
		description:
			"Wait until any requested subagent finishes, errors, is interrupted, or the timeout expires. Use sparingly; work locally while agents run when possible.",
		parameters: WaitParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const current = await ensureManager(ctx);
				const result = await current.manager.wait(params.ids, params.timeout_ms, signal, (snapshots) => {
					onUpdate?.({
						content: [{ type: "text", text: "Waiting for subagents…" }],
						details: { action: "wait", snapshots } satisfies AgentToolDetails,
					});
				});
				const snapshots = Object.values(result.status).filter((value): value is AgentSnapshot => "id" in value);
				const status = Object.fromEntries(
					Object.entries(result.status).map(([target, value]) => [target, "id" in value ? wireStatus(value) : "not_found"]),
				);
				const details: AgentToolDetails = { action: "wait", snapshots, timedOut: result.timedOut };
				return textResult(JSON.stringify({ status, timed_out: result.timedOut }, null, 2), details);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { action: "wait", snapshots: [], message }, true);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall("wait", args as Record<string, unknown>, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderSubagentResult(result.details as AgentToolDetails | undefined, expanded, theme, isPartial);
		},
	});

	pi.registerTool({
		name: "close_agent",
		label: "Close agent",
		description:
			"Close a subagent process and release its concurrency slot. Completed agents remain reusable and count toward the limit until closed.",
		parameters: CloseParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const current = await ensureManager(ctx);
				const result = await current.manager.close(params.target);
				const previousStatus = "id" in result.previousSnapshot ? wireStatus(result.previousSnapshot) : "not_found";
				return textResult(JSON.stringify({ previous_status: previousStatus }), {
					action: "close",
					snapshots: result.snapshot ? [result.snapshot] : [],
					previousSnapshot: "id" in result.previousSnapshot ? result.previousSnapshot : undefined,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { action: "close", snapshots: [], message }, true);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall("close", args as Record<string, unknown>, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderSubagentResult(result.details as AgentToolDetails | undefined, expanded, theme, isPartial);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List agents",
		description: "List live subagents owned by this parent process and their current status.",
		parameters: ListParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const current = await ensureManager(ctx);
				const snapshots = current.manager.list();
				return textResult(JSON.stringify({ agents: snapshots.map(listSummary) }, null, 2), { action: "list", snapshots });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(message, { action: "list", snapshots: [], message }, true);
			}
		},
		renderCall(args, theme) {
			return renderSubagentCall("list", args as Record<string, unknown>, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderSubagentResult(result.details as AgentToolDetails | undefined, expanded, theme, isPartial);
		},
	});
}
