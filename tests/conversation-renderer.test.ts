import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import * as Pi from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ConversationMirror } from "../extensions/subagent/conversation-mirror.ts";
import { ConversationRenderer } from "../extensions/subagent/conversation-renderer.ts";

before(() => { Pi.initTheme("dark"); });
const text = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
function fixture() {
	let redraws = 0;
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender() { redraws++; } } as unknown as TUI;
	const renderer = new ConversationRenderer(tui), mirror = new ConversationMirror();
	const output = Array.from({ length: 30 }, (_, i) => `output_line_${i}`).join("\n");
	mirror.replace([
		{ role: "user", timestamp: 1, content: "Inspect the code" },
		{ role: "assistant", timestamp: 2, stopReason: "stop", content: [
			{ type: "thinking", thinking: "Reasoning about the defect" },
			{ type: "text", text: "## Findings\n**Important answer**\n\n```ts\nconst value = 1;\n```" },
			{ type: "toolCall", id: "tool", name: "bash", arguments: { command: "printf output" } },
		] },
		{ role: "toolResult", timestamp: 3, toolCallId: "tool", toolName: "bash", content: [{ type: "text", text: output }], isError: false },
	]);
	return { renderer, mirror, tui, redraws: () => redraws, render: () => text(renderer.render(mirror.items, 100, "/repo")) };
}
describe("native child transcript rendering", () => {
	it("renders Markdown, thinking and tool output instead of flattened role/text rows", () => {
		const h = fixture();
		try {
			const rendered = h.render();
			assert.match(rendered, /Important answer/); assert.match(rendered, /Reasoning about the defect/); assert.match(rendered, /const value/);
			assert.doesNotMatch(rendered, /\*\*Important|```ts/);
			assert.match(rendered, /printf output/); assert.match(rendered, /output_line_/);
			h.renderer.toggleTools(); const expanded = h.render();
			assert.match(expanded, /output_line_0/); assert.match(expanded, /output_line_29/);
			h.renderer.toggleThinking(); assert.doesNotMatch(h.render(), /Reasoning about the defect/); assert.match(h.render(), /Important answer/);
			h.renderer.toggleThinking(); assert.match(h.render(), /Reasoning about the defect/);
		} finally { h.renderer.dispose(); }
	});
	it("uses the exact public component prototypes styled by the parent rather than copied renderers", () => {
		const prototypes = [Pi.UserMessageComponent.prototype, Pi.AssistantMessageComponent.prototype, Pi.ToolExecutionComponent.prototype];
		const original = prototypes.map((prototype) => prototype.render);
		const counts = [0, 0, 0];
		const h = fixture();
		try {
			prototypes.forEach((prototype, index) => {
				prototype.render = function (width: number): string[] { counts[index]++; return [`PARENT_STYLE_${index}`, ...original[index].call(this as never, width)]; };
			});
			const rendered = h.render();
			for (let index = 0; index < 3; index++) { assert.ok(counts[index] > 0); assert.match(rendered, new RegExp(`PARENT_STYLE_${index}`)); }
		} finally { prototypes.forEach((prototype, index) => { prototype.render = original[index]; }); h.renderer.dispose(); }
	});
	it("does not mutate private source messages and clears components on reset/dispose", () => {
		const h = fixture();
		try {
			const original = JSON.stringify(h.mirror.items); h.render(); h.renderer.toggleTools(); h.renderer.invalidate(); h.render();
			assert.equal(JSON.stringify(h.mirror.items), original);
			h.renderer.reset(); assert.match(h.render(), /Important answer/);
			h.renderer.dispose(); assert.deepEqual(h.renderer.render(h.mirror.items, 100, "/repo"), []);
		} finally { h.renderer.dispose(); }
	});
});
