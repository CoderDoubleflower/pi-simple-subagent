import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentStatus } from "./types.ts";
import { InlineAgentStore, type InlineAgent } from "./inline-store.ts";
import { safeText } from "./conversation-mirror.ts";

// Pi 0.84 does not export the full render context type at the package root.
export interface InlineRenderContext {
	toolCallId: string;
	invalidate(): void;
	args?: object;
	state?: { spawnDetails?: InlineDetails };
}
export type InlineAction = "spawn" | "send" | "wait" | "close" | "list";
export interface InlineDetails { action: InlineAction; agents: InlineAgent[]; message?: string; timedOut?: boolean }
export function safeLine(value: unknown, max = 200): string {
	return safeText(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
}
export function elapsed(start: number, end = Date.now()): string {
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
const labels: Record<AgentStatus, string> = { starting: "Starting", running: "Running", completed: "Completed", errored: "Failed", interrupted: "Interrupted", closed: "Closed" };
const EMPTY_ROW: Component = { render: () => [], invalidate() {} };

function spawnHeading(
	readDetails: () => InlineDetails | undefined,
	args: Record<string, unknown>,
	theme: Theme,
	store?: InlineAgentStore,
): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			if (width <= 0) return [];
			const details = readDetails();
			const saved = Array.isArray(details?.agents) ? details.agents[0] : undefined;
			// Resolve by immutable agent ID, never by a task name that can be reused.
			const agent = saved ? store?.get(saved.id) ?? saved : undefined;
			const profile = safeLine(agent?.profileName ?? args.agent_type, 48);
			const task = safeLine(agent?.taskName ?? args.task_name, 64);
			// Raw model/effort arguments may have been overridden by profile settings.
			// Only display resolved metadata; old history without effort omits it.
			const modelAndEffort = [safeLine(agent?.model, 120), safeLine(agent?.effort, 16)].filter(Boolean).join(" ");
			const information = [profile, task, modelAndEffort].filter(Boolean).join(" · ");
			const color = details?.message || agent?.status === "errored" ? "error" : agent?.status === "completed" ? "success" : "accent";
			let text = theme.fg(color, "● ") + theme.fg("toolTitle", theme.bold("Spawn agent"));
			if (information) text += theme.fg("muted", ` (${information})`);
			if (details?.message) text += theme.fg("error", ` · Failed: ${safeLine(details.message)}`);
			else if (agent?.status === "errored") text += theme.fg("error", " · Failed");
			else if (agent?.status === "interrupted") text += theme.fg("muted", " · Interrupted");
			// Keep compact spawn headings on one row, including narrow terminals.
			return [truncateToWidth(text, width)];
		},
	};
}

export function renderInlineCall(action: InlineAction, args: Record<string, unknown>, theme: Theme, store?: InlineAgentStore, context?: InlineRenderContext): Component {
	if (action === "spawn") return spawnHeading(() => context?.state?.spawnDetails, args, theme, store);
	const title = { send: "Message agent", wait: "Waiting for subagents", close: "Close agent", list: "Subagents" }[action];
	const target = args.target;
	return new Text(theme.fg("accent", "● ") + theme.fg("toolTitle", theme.bold(title)) + (target ? theme.fg("muted", ` (${safeLine(target, 64)})`) : ""), 0, 0);
}
export function renderInlineResult(details: InlineDetails | undefined, partial: boolean, theme: Theme, store?: InlineAgentStore, context?: InlineRenderContext): Component {
	if (!details) return new Text(theme.fg("dim", "  ⎿  Working…"), 0, 0);
	const snapshots = Array.isArray(details.agents) ? details.agents : [];
	if (context && snapshots.length) store?.watch(context.toolCallId, snapshots.map((agent) => agent.id), context.invalidate);
	if (details.action === "spawn") {
		if (context?.state) {
			// Pi constructs call before result, but renders both afterwards. The call
			// component reads this shared state lazily, so there is only one heading.
			context.state.spawnDetails = details;
			return EMPTY_ROW;
		}
		return spawnHeading(() => details, (context?.args ?? {}) as Record<string, unknown>, theme, store);
	}
	const agents = snapshots.map((agent) => store?.get(agent.id) ?? agent);
	const lines = agents.slice(0, 8).map((agent) => {
		const color = agent.status === "errored" ? "error" : agent.status === "completed" ? "success" : "muted";
		const extra = details.action === "wait" ? "" : ` · ${agent.toolUses} tools${agent.model ? ` · ${safeLine(agent.model, 120)}` : ""}`;
		return theme.fg("dim", "  ⎿  ") + theme.fg(color, `${safeLine(agent.profileName, 48)} · ${safeLine(agent.taskName, 64)} · ${labels[agent.status] ?? "Unknown"}`)
			+ theme.fg("dim", ` · ${elapsed(agent.startedAt, agent.completedAt)}${extra}`);
	});
	if (agents.length > 8) lines.push(theme.fg("dim", `     +${agents.length - 8} more · /agents to inspect`));
	if (details.message) lines.push(theme.fg("error", `  ⎿  ${safeLine(details.message)}`));
	else if (details.action === "wait") lines.push(theme.fg("dim", partial ? "  ⎿  Waiting for a new result…" : details.timedOut ? "  ⎿  Still running · wait deadline reached" : "  ⎿  Wait finished"));
	else if (!lines.length) lines.push(theme.fg("dim", "  ⎿  No active agents"));
	return new Text(lines.join("\n"), 0, 0);
}
