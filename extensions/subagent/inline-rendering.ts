import type { Theme, ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { AgentStatus } from "./types.ts";
import { InlineAgentStore, type InlineAgent } from "./inline-store.ts";

export type InlineAction = "spawn" | "send" | "wait" | "close" | "list";
export interface InlineDetails { action: InlineAction; agents: InlineAgent[]; message?: string; timedOut?: boolean }
export function safeLine(value: unknown, max = 200): string {
	return (typeof value === "string" ? value : "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export function elapsed(start: number, end = Date.now()): string {
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
const labels: Record<AgentStatus, string> = { starting: "Starting", running: "Running", completed: "Completed", errored: "Failed", interrupted: "Interrupted", closed: "Closed" };
export function renderInlineCall(action: InlineAction, args: Record<string, unknown>, theme: Theme): Text {
	const title = { spawn: "Spawn agent", send: "Message agent", wait: "Waiting for subagents", close: "Close agent", list: "Subagents" }[action];
	const target = action === "spawn" ? args.task_name : args.target;
	return new Text(theme.fg("accent", "● ") + theme.fg("toolTitle", theme.bold(title)) + (target ? theme.fg("muted", ` (${safeLine(target, 64)})`) : ""), 0, 0);
}
export function renderInlineResult(details: InlineDetails | undefined, partial: boolean, theme: Theme, store?: InlineAgentStore, context?: ToolRenderContext): Text {
	if (!details) return new Text(theme.fg("dim", "  ⎿  Working…"), 0, 0);
	const snapshots = Array.isArray(details.agents) ? details.agents : [];
	if (context && snapshots.length) store?.watch(context.toolCallId, snapshots.map((agent) => agent.id), context.invalidate);
	const agents = snapshots.map((agent) => store?.get(agent.id) ?? agent);
	const lines = agents.slice(0, 8).map((agent) => {
		const color = agent.status === "errored" ? "error" : agent.status === "completed" ? "success" : "muted";
		return theme.fg("dim", "  ⎿  ") + theme.fg(color, `${safeLine(agent.profileName, 48)} · ${safeLine(agent.taskName, 64)} · ${labels[agent.status] ?? "Unknown"}`)
			+ theme.fg("dim", ` · ${elapsed(agent.startedAt, agent.completedAt)} · ${agent.toolUses} tools${agent.model ? ` · ${safeLine(agent.model, 120)}` : ""}`);
	});
	if (agents.length > 8) lines.push(theme.fg("dim", `     +${agents.length - 8} more · /agents to inspect`));
	if (details.message) lines.push(theme.fg("error", `  ⎿  ${safeLine(details.message)}`));
	else if (details.action === "wait") lines.push(theme.fg("dim", partial ? "  ⎿  Waiting for a new result…" : details.timedOut ? "  ⎿  Still running · wait deadline reached" : "  ⎿  Wait finished"));
	else if (!lines.length) lines.push(theme.fg("dim", "  ⎿  No active agents"));
	return new Text(lines.join("\n"), 0, 0);
}
