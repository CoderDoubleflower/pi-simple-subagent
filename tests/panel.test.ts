import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createSubagentPanel, installSubagentPanel, panelLines, PANEL_KEY, PANEL_MOUNTED, PANEL_STATE } from "../extensions/subagent/panel.ts";
import type { AgentDisplay, SubagentCoordinator } from "../extensions/subagent/coordinator.ts";

const theme = { fg: (_name: string, value: string) => value } as unknown as Theme;
function row(id = "a"): AgentDisplay {
	return { id, taskName: id, profileName: "worker", status: "running", startedAt: 0, toolUses: 2, showElapsed: true, showToolCount: true };
}
function source(rows: AgentDisplay[]) {
	const callbacks = new Set<() => void>();
	return { display: () => rows, subscribeDisplay: (fn: () => void) => { callbacks.add(fn); return () => { callbacks.delete(fn); }; }, callbacks };
}
describe("fixed subagent panel", () => {
	it("renders bounded metadata rows, no transcript, and prioritizes running tasks", () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({ ...row(`agent_${i}`), status: i === 11 ? "running" as const : "completed" as const }));
		const lines = panelLines(rows, 5000);
		assert.equal(lines.length, 7); assert.match(lines[1], /agent_11/); assert.match(lines.join("\n"), /另有 8 个子代理/);
		assert.deepEqual(panelLines([]), []);
	});
	it("sanitizes control characters and respects narrow widths", () => {
		const data = source([{ ...row(), taskName: "a\x1b\nsecret" }]);
		assert.ok(!panelLines(data.display()).join("\n").includes("\x1b"));
		const panel = createSubagentPanel({ requestRender() {} } as unknown as TUI, theme, data);
		assert.deepEqual(panel.render(0), []); assert.ok(panel.render(8).length > 0); panel.dispose();
	});
	it("subscribes independently of waits and cleans up on disposal", () => {
		const data = source([row()]); let renders = 0;
		const panel = createSubagentPanel({ requestRender() { renders++; } } as unknown as TUI, theme, data);
		for (const callback of data.callbacks) callback(); assert.equal(renders, 1);
		panel.dispose(); panel.dispose(); assert.equal(data.callbacks.size, 0); assert.deepEqual(panel.render(80), []);
	});
	it("reinserts after spinner remount and emits a metadata-only layout event", () => {
		const handlers = new Map<string, Set<(data: unknown) => void>>(); const widgets = new Map<string, unknown>(); const emitted: Array<[string, unknown]> = [];
		const events = {
			on(name: string, fn: (data: unknown) => void) { const set = handlers.get(name) ?? new Set(); handlers.set(name, set); set.add(fn); return () => { set.delete(fn); }; },
			emit(name: string, data: unknown) { emitted.push([name, data]); for (const fn of handlers.get(name) ?? []) fn(data); },
		};
		const ctx = { hasUI: true, ui: { setWidget(key: string, value: unknown) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); } } } as unknown as ExtensionContext;
		const data = source([row()]); const installation = installSubagentPanel({ events } as unknown as ExtensionAPI, ctx, data as unknown as SubagentCoordinator);
		widgets.set("open-tui-spinner", {}); events.emit("open-tui:spinner:mounted:v1", { version: 1 });
		assert.deepEqual([...widgets.keys()], ["open-tui-spinner", PANEL_KEY]);
		assert.ok(emitted.some(([name]) => name === PANEL_MOUNTED));
		assert.ok(emitted.some(([name, payload]) => name === PANEL_STATE && JSON.stringify(payload) === '{"version":1,"visible":true}'));
		installation.dispose(); assert.ok(!widgets.has(PANEL_KEY)); assert.equal(data.callbacks.size, 0);
		assert.ok([...handlers.values()].every((set) => set.size === 0));
	});
	it("does not mount UI resources for RPC/headless parents", () => {
		const installation = installSubagentPanel({} as ExtensionAPI, { hasUI: false } as ExtensionContext, source([]) as unknown as SubagentCoordinator);
		installation.dispose();
	});
});
