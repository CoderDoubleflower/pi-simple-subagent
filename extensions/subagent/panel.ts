import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentDisplay, SubagentCoordinator } from "./coordinator.ts";
import { formatDuration } from "./rendering.ts";

// Versioned layout-only protocol, shared with pi-open-tui. Never publish child transcripts.
export const PANEL_MOUNTED = "pi-simple-subagent:panel-mounted";
export const PANEL_STATE = "pi-simple-subagent:panel-state";
export const PANEL_STATE_REQUEST = "pi-simple-subagent:panel-state-request";
export const PANEL_KEY = "pi-simple-subagent-panel";
const SPINNER_MOUNTED = "open-tui:spinner:mounted:v1";
const active = (row: AgentDisplay) => row.status === "starting" || row.status === "running";
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function panelLines(rows: readonly AgentDisplay[], now = Date.now(), maxRows = 4): string[] {
	if (!rows.length) return [];
	const count = rows.filter(active).length;
	const sorted = [...rows].sort((a, b) => Number(active(b)) - Number(active(a)) || a.startedAt - b.startedAt);
	const labels = { starting: "启动中", running: "运行中", completed: "已完成", errored: "失败", interrupted: "已中断", closed: "已关闭" };
	const result = [`  子代理 · ${count} 个运行中 · ${rows.length - count} 个已结束`];
	const shown = sorted.slice(0, Math.max(1, maxRows));
	shown.forEach((row, index) => {
		const stats = [row.showElapsed ? formatDuration((row.completedAt ?? now) - row.startedAt) : "", row.showToolCount ? `${row.toolUses} 次工具调用` : ""].filter(Boolean);
		result.push(`  ${index === shown.length - 1 ? "└─" : "├─"} ${clean(row.profileName)} · ${clean(row.taskName)} · ${labels[row.status]}${stats.length ? ` · ${stats.join(" · ")}` : ""}`);
	});
	if (rows.length > shown.length) result.push(`     另有 ${rows.length - shown.length} 个子代理`);
	result.push("");
	return result;
}

export function createSubagentPanel(tui: TUI, theme: Theme, source: Pick<SubagentCoordinator, "display" | "subscribeDisplay">): Component & { dispose(): void } {
	let disposed = false;
	const unsubscribe = source.subscribeDisplay(() => { if (!disposed) tui.requestRender(); });
	const timer = setInterval(() => { if (!disposed && source.display().some(active)) tui.requestRender(); }, 1_000);
	timer.unref?.();
	return {
		invalidate() {},
		render(width) {
			if (disposed || width <= 0) return [];
			return panelLines(source.display()).map((line) => truncateToWidth(theme.fg("muted", line), width));
		},
		dispose() { if (disposed) return; disposed = true; clearInterval(timer); unsubscribe(); },
	};
}

export function installSubagentPanel(pi: ExtensionAPI, ctx: ExtensionContext, source: SubagentCoordinator): { dispose(): void } {
	if (!ctx.hasUI) return { dispose() {} };
	let disposed = false;
	let component: ReturnType<typeof createSubagentPanel> | undefined;
	const publish = () => { if (!disposed) pi.events.emit(PANEL_STATE, { version: 1, visible: source.display().length > 0 }); };
	const mount = () => {
		if (disposed) return;
		component?.dispose();
		ctx.ui.setWidget(PANEL_KEY, undefined);
		ctx.ui.setWidget(PANEL_KEY, (tui, theme) => {
			component = createSubagentPanel(tui, theme, source);
			return component;
		}, { placement: "aboveEditor" });
		// Todo reinserts after this row. Replaying on spinner remount makes extension load order irrelevant.
		pi.events.emit(PANEL_MOUNTED, { version: 1 });
		publish();
	};
	const onSpinner = pi.events.on(SPINNER_MOUNTED, (data: unknown) => {
		if ((data as { version?: number } | null)?.version === 1) mount();
	});
	const onRequest = pi.events.on(PANEL_STATE_REQUEST, publish);
	const onChange = source.subscribeDisplay(publish);
	mount();
	return { dispose() {
		if (disposed) return;
		disposed = true;
		onSpinner(); onRequest(); onChange(); component?.dispose();
		ctx.ui.setWidget(PANEL_KEY, undefined);
		pi.events.emit(PANEL_STATE, { version: 1, visible: false });
	} };
}
