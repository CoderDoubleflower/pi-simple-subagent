import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentActivity, AgentSnapshot, AgentStatus, AgentToolDetails } from "./types.ts";

function formatCount(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const minuteRest = minutes % 60;
	return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function friendlyToolName(name: string): string {
	const known: Record<string, string> = {
		read: "Read",
		write: "Write",
		edit: "Edit",
		grep: "Grep",
		find: "Find",
		ls: "List",
		bash: "Bash",
		shell_command: "Shell",
		powershell: "PowerShell",
		apply_patch: "Update",
		web_search: "WebSearch",
	};
	return known[name] ?? name;
}

function formatActivity(activity: AgentActivity): string {
	const name = friendlyToolName(activity.name);
	return activity.summary && activity.summary !== activity.name ? `${name}(${activity.summary})` : name;
}

function terminalStatusLabel(status: AgentStatus): string {
	switch (status) {
		case "starting":
			return "initializing";
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "errored":
			return "failed";
		case "interrupted":
			return "interrupted";
		case "closed":
			return "stopped";
	}
}

function statusColor(status: AgentStatus): "success" | "error" | "warning" | "dim" | "muted" | "accent" {
	switch (status) {
		case "completed":
			return "success";
		case "errored":
			return "error";
		case "interrupted":
			return "warning";
		case "closed":
			return "dim";
		case "starting":
			return "muted";
		case "running":
			return "accent";
	}
}

function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "starting":
			return "○";
		case "running":
			return "✻";
		case "completed":
			return "●";
		case "errored":
			return "●";
		case "interrupted":
			return "●";
		case "closed":
			return "○";
	}
}

function firstLine(value: string, max = 140): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function summaryParts(snapshot: AgentSnapshot): string[] {
	const parts: string[] = [];
	if (snapshot.display.showToolActivity) {
		const toolUses = snapshot.activities.filter((item) => item.kind === "tool").length;
		if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
	}
	if (snapshot.display.showUsage) {
		const totalTokens = snapshot.usage.input + snapshot.usage.output;
		if (totalTokens > 0) parts.push(`${formatCount(totalTokens)} tokens`);
	}
	if (snapshot.display.showElapsed) {
		parts.push(formatDuration((snapshot.completedAt ?? Date.now()) - snapshot.startedAt));
	}
	return parts;
}

function detailedUsage(snapshot: AgentSnapshot): string {
	const parts: string[] = [];
	if (snapshot.usage.turns) parts.push(`${snapshot.usage.turns} turn${snapshot.usage.turns === 1 ? "" : "s"}`);
	if (snapshot.usage.input) parts.push(`↑${formatCount(snapshot.usage.input)}`);
	if (snapshot.usage.output) parts.push(`↓${formatCount(snapshot.usage.output)}`);
	if (snapshot.usage.cacheRead) parts.push(`R${formatCount(snapshot.usage.cacheRead)}`);
	if (snapshot.usage.cacheWrite) parts.push(`W${formatCount(snapshot.usage.cacheWrite)}`);
	if (snapshot.usage.cost) parts.push(`$${snapshot.usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function currentActivity(snapshot: AgentSnapshot, previousSnapshot?: AgentSnapshot): string {
	if (snapshot.status === "closed" && previousSnapshot) {
		return `Stopped · was ${terminalStatusLabel(previousSnapshot.status)}`;
	}
	switch (snapshot.status) {
		case "starting":
			return "Initializing…";
		case "running": {
			const activity = snapshot.activities.findLast((item) => item.kind === "tool");
			return activity ? formatActivity(activity) : "Initializing…";
		}
		case "completed":
			return "Done";
		case "errored":
			return snapshot.error ? `Failed: ${firstLine(snapshot.error)}` : "Failed";
		case "interrupted":
			return "Interrupted";
		case "closed":
			return "Stopped";
	}
}

function agentIdentity(snapshot: AgentSnapshot, theme: Theme): string {
	return (
		theme.fg("toolTitle", theme.bold(snapshot.profileName)) +
		theme.fg("muted", " (") +
		theme.fg("text", snapshot.taskName) +
		theme.fg("muted", ")")
	);
}

function singleStatusLine(snapshot: AgentSnapshot, theme: Theme, previousSnapshot?: AgentSnapshot): string {
	const stats = summaryParts(snapshot);
	const suffix = stats.length > 0 ? ` (${stats.join(" · ")})` : "";
	return (
		theme.fg("dim", "  ⎿  ") +
		theme.fg(statusColor(snapshot.status), `${statusGlyph(snapshot.status)} ${currentActivity(snapshot, previousSnapshot)}`) +
		theme.fg("dim", suffix)
	);
}

function treeHeader(snapshot: AgentSnapshot, isLast: boolean, theme: Theme): string {
	const stats = summaryParts(snapshot);
	return (
		theme.fg("dim", `${isLast ? "└─" : "├─"} `) +
		agentIdentity(snapshot, theme) +
		(stats.length > 0 ? theme.fg("dim", ` · ${stats.join(" · ")}`) : "")
	);
}

function treeStatus(snapshot: AgentSnapshot, isLast: boolean, theme: Theme, previousSnapshot?: AgentSnapshot): string {
	return (
		theme.fg("dim", isLast ? "   ⎿  " : "│  ⎿  ") +
		theme.fg(statusColor(snapshot.status), `${statusGlyph(snapshot.status)} ${currentActivity(snapshot, previousSnapshot)}`)
	);
}

function addRecentCollapsedActivity(container: Container, snapshot: AgentSnapshot, theme: Theme): void {
	if (snapshot.status !== "running" || !snapshot.display.showToolActivity) return;
	const count = Math.max(0, snapshot.display.collapsedActivityItems - 1);
	if (count === 0) return;
	const recent = snapshot.activities.filter((item) => item.kind === "tool").slice(-count - 1, -1);
	for (const activity of recent) {
		container.addChild(new Text(theme.fg("dim", `     ${formatActivity(activity)}`), 0, 0));
	}
}

function addProgressSection(container: Container, snapshot: AgentSnapshot, theme: Theme): void {
	if (!snapshot.display.showToolActivity || snapshot.activities.length === 0) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", theme.bold("     Progress")), 0, 0));
	for (let index = 0; index < snapshot.activities.length; index++) {
		const activity = snapshot.activities[index];
		const latest = index === snapshot.activities.length - 1;
		const marker = latest ? "› " : "  ";
		const color = activity.status === "errored" ? "error" : latest && activity.status === "running" ? "text" : "dim";
		const elapsed = activity.endedAt ? ` · ${formatDuration(activity.endedAt - activity.startedAt)}` : "";
		container.addChild(
			new Text(
				theme.fg("dim", `     ${marker}`) + theme.fg(color, formatActivity(activity)) + theme.fg("dim", elapsed),
				0,
				0,
			),
		);
	}
}

function addMetadataSection(container: Container, snapshot: AgentSnapshot, theme: Theme): void {
	const tools = snapshot.tools === "none" ? "none" : snapshot.tools.join(", ") || "none";
	const settings = [
		snapshot.model ? `model: ${snapshot.model}` : "model: default",
		snapshot.effort ? `effort: ${snapshot.effort}` : "effort: default",
		`tools: ${tools}`,
		`cwd: ${snapshot.cwd}`,
	].join(" · ");
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", theme.bold("     Configuration")), 0, 0));
	container.addChild(new Text(theme.fg("dim", `       ${settings}`), 0, 0));
	const usage = detailedUsage(snapshot);
	if (usage) container.addChild(new Text(theme.fg("dim", `       usage: ${usage}`), 0, 0));
}

function addMarkdownSection(container: Container, title: string, content: string, theme: Theme, error = false): void {
	if (!content.trim()) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg(error ? "error" : "dim", theme.bold(`     ${title}`)), 0, 0));
	container.addChild(new Markdown(content, 7, 0, getMarkdownTheme()));
}

function hasExpandableDetails(snapshot: AgentSnapshot): boolean {
	return Boolean(
		snapshot.profileDescription ||
			snapshot.message ||
			snapshot.model ||
			snapshot.effort ||
			snapshot.activities.length > 0 ||
			snapshot.finalOutput ||
			snapshot.error ||
			snapshot.stderr,
	);
}

function snapshotComponent(
	snapshot: AgentSnapshot,
	expanded: boolean,
	includeTitle: boolean,
	isLast: boolean,
	theme: Theme,
	previousSnapshot?: AgentSnapshot,
): Container {
	const container = new Container();
	if (includeTitle) {
		container.addChild(new Text(treeHeader(snapshot, isLast, theme), 0, 0));
		container.addChild(new Text(treeStatus(snapshot, isLast, theme, previousSnapshot), 0, 0));
	} else {
		container.addChild(new Text(singleStatusLine(snapshot, theme, previousSnapshot), 0, 0));
	}

	if (!expanded) {
		addRecentCollapsedActivity(container, snapshot, theme);
		return container;
	}

	if (snapshot.profileDescription) container.addChild(new Text(theme.fg("dim", `     ${snapshot.profileDescription}`), 0, 0));
	addProgressSection(container, snapshot, theme);
	addMetadataSection(container, snapshot, theme);
	addMarkdownSection(container, "Prompt", snapshot.message, theme);
	if (snapshot.error) addMarkdownSection(container, "Error", snapshot.error, theme, true);
	else if (snapshot.finalOutput) addMarkdownSection(container, "Response", snapshot.finalOutput, theme);
	if (snapshot.stderr) addMarkdownSection(container, "Process log", snapshot.stderr, theme, true);
	return container;
}

function targetList(args: Record<string, unknown>): string {
	if (Array.isArray(args.ids)) {
		const ids = args.ids.filter((value): value is string => typeof value === "string");
		if (ids.length <= 2) return ids.join(", ") || "subagents";
		return `${ids.slice(0, 2).join(", ")} +${ids.length - 2}`;
	}
	return "subagents";
}

export function renderSubagentCall(action: AgentToolDetails["action"], args: Record<string, unknown>, theme: Theme): Text {
	const dot = theme.fg("accent", "● ");
	if (action === "spawn") {
		const profile = typeof args.agent_type === "string" ? args.agent_type : "default";
		const taskName = typeof args.task_name === "string" ? args.task_name : "subagent";
		return new Text(
			dot + theme.fg("toolTitle", theme.bold(profile)) + theme.fg("muted", " (") + theme.fg("text", taskName) + theme.fg("muted", ")"),
			0,
			0,
		);
	}
	if (action === "send") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Message")) + theme.fg("muted", ` (${String(args.target ?? "subagent")})`), 0, 0);
	}
	if (action === "wait") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Wait")) + theme.fg("muted", ` (${targetList(args)})`), 0, 0);
	}
	if (action === "close") {
		return new Text(dot + theme.fg("toolTitle", theme.bold("Stop")) + theme.fg("muted", ` (${String(args.target ?? "subagent")})`), 0, 0);
	}
	return new Text(dot + theme.fg("toolTitle", theme.bold("Subagents")), 0, 0);
}

export function renderSubagentResult(
	details: AgentToolDetails | undefined,
	expanded: boolean,
	theme: Theme,
	isPartial = false,
): Container | Text {
	if (!details) return new Text(theme.fg("dim", "  ⎿  No subagent details"), 0, 0);
	const container = new Container();
	if (details.message) container.addChild(new Text(theme.fg("error", `  ⎿  ${details.message}`), 0, 0));
	if (details.snapshots.length === 0) {
		if (!details.message) container.addChild(new Text(theme.fg("dim", "  ⎿  No subagents"), 0, 0));
		return container;
	}

	const includeTitle = details.action === "wait" || details.action === "list" || details.snapshots.length > 1;
	for (let index = 0; index < details.snapshots.length; index++) {
		if (index > 0 && expanded) container.addChild(new Spacer(1));
		container.addChild(
			snapshotComponent(
				details.snapshots[index],
				expanded,
				includeTitle,
				index === details.snapshots.length - 1,
				theme,
				details.action === "close" ? details.previousSnapshot : undefined,
			),
		);
	}

	if (details.timedOut) container.addChild(new Text(theme.fg("warning", "  ⎿  Wait timed out · agents are still running"), 0, 0));
	else if (isPartial && details.action === "wait") container.addChild(new Text(theme.fg("dim", "  ⎿  Waiting for an agent update…"), 0, 0));

	if (
		!expanded &&
		details.snapshots.some((snapshot) => snapshot.display.showExpandHint && hasExpandableDetails(snapshot))
	) {
		container.addChild(new Text(theme.fg("dim", "     Ctrl+O to expand details"), 0, 0));
	}
	return container;
}
