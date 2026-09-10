import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentsView } from "../extensions/subagent/agents-view.ts";
import type { AgentManager } from "../extensions/subagent/agent-manager.ts";
import { DEFAULT_CONFIG } from "../extensions/subagent/config.ts";
import type { AgentSnapshot } from "../extensions/subagent/types.ts";
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const keys = { matches: (data: string, action: string) => ({ "tui.select.cancel": "\u001b", "tui.select.up": "\u001b[A", "tui.select.down": "\u001b[B", "tui.select.confirm": "\r", "tui.input.tab": "\t" } as Record<string, string>)[action] === data } as unknown as KeybindingsManager;
function harness() {
	const terminal = { rows: 20, columns: 80 }; let renders = 0, closed = 0, subscriptions = 0;
	const child: AgentSnapshot = { id: "id", taskName: "inspect", profileName: "explorer", status: "completed", model: "p/child", message: "private task", finalOutput: "private answer", stderr: "",
		cwd: "/repo", tools: ["read"], activities: [], startedAt: Date.now(), updatedAt: Date.now(), display: DEFAULT_CONFIG.output,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 } };
	const manager = { list: () => [child], subscribe() { subscriptions++; return () => { subscriptions--; }; },
		subscribeEvents() { subscriptions++; return () => { subscriptions--; }; },
		async getMessages() { return [{ role: "user", timestamp: 1, content: "private task" }, { role: "assistant", timestamp: 2, content: "private answer" }]; } };
	const prompts: Array<{ target: string; text: string; interrupt: boolean }> = [];
	const view = new AgentsView({ terminal, requestRender() { renders++; } } as unknown as TUI, theme, keys, manager as unknown as AgentManager,
		async (target, text, interrupt) => { prompts.push({ target, text, interrupt }); }, () => { closed++; });
	return { view, prompts, terminal, counts: () => ({ renders, closed, subscriptions }) };
}
describe("agents view", () => {
	it("opens the selected context and routes editor input only to that child", async () => {
		const h = harness();
		try {
			assert.match(h.view.render(80).join("\n"), /Agents/); assert.doesNotMatch(h.view.render(80).join("\n"), /private answer/);
			await h.view.enter("id"); assert.match(h.view.render(80).join("\n"), /private answer/);
			h.view.focused = true; h.view.handleInput("continue"); h.view.handleInput("\r");
			await h.view.conversation.settleInput();
			assert.deepEqual(h.prompts, [{ target: "id", text: "continue", interrupt: false }]);
		} finally { h.view.dispose(); }
		assert.equal(h.counts().subscriptions, 0);
	});
	it("toggles send mode and returns to the agent list without closing the child", async () => {
		const h = harness();
		try {
			await h.view.enter("id"); h.view.handleInput("\t");
			assert.match(h.view.render(80).join("\n"), /Steer current work/);
			h.view.handleInput("\u001b"); assert.equal(h.view.conversation.selected, undefined); assert.equal(h.counts().closed, 0);
			h.view.handleInput("\u001b"); assert.equal(h.counts().closed, 1);
		} finally { h.view.dispose(); }
	});
	it("fits terminal width and height in list and child views", async () => {
		const h = harness();
		try {
			for (const width of [1, 12, 32, 80]) { const lines = h.view.render(width); assert.ok(lines.length <= 20); assert.ok(lines.every((line) => visibleWidth(line) <= width)); }
			await h.view.enter("id");
			for (const width of [1, 12, 32, 80]) { const lines = h.view.render(width); assert.ok(lines.length <= 20); assert.ok(lines.every((line) => visibleWidth(line) <= width)); }
		} finally { h.view.dispose(); }
	});
	it("disposes pending redraws and focus without stopping the parent application", async () => {
		const h = harness(); await h.view.enter("id"); h.view.handleInput("\u0007"); assert.equal(h.counts().closed, 1);
		h.view.dispose(); const before = h.counts().renders;
		await new Promise((resolve) => setTimeout(resolve, 70)); assert.equal(h.counts().renders, before); assert.deepEqual(h.view.render(80), []);
	});
});
