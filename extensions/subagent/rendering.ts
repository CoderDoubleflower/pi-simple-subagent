import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolDetails } from "./types.ts";

/** Both expanded and collapsed tool rows stay empty. Results still reach the parent model. */
export const HIDDEN_TOOL_ROW: Component = { invalidate() {}, render() { return []; } };
export function renderSubagentCall(_action: AgentToolDetails["action"], _args: Record<string, unknown>, _theme: Theme): Component {
	return HIDDEN_TOOL_ROW;
}
export function renderSubagentResult(_details: AgentToolDetails | undefined, _expanded: boolean, _theme: Theme, _isPartial = false): Component {
	return HIDDEN_TOOL_ROW;
}
export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
