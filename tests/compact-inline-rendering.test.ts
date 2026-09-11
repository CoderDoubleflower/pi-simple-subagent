import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import simpleSubagentExtension from "../extensions/subagents.ts";
import { DEFAULT_CONFIG } from "../extensions/subagent/config.ts";
import { InlineAgentStore, inlineAgent, type InlineAgent } from "../extensions/subagent/inline-store.ts";
import { renderInlineCall, renderInlineResult, type InlineDetails, type InlineRenderContext } from "../extensions/subagent/inline-rendering.ts";
import type { AgentSnapshot } from "../extensions/subagent/types.ts";

before(() => { initTheme("dark"); });
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const expected = "● Spawn agent (explorer · pi_plugin_sources · sub2api/gpt-5.6-luna max)";
function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return { id: "agent_first", taskName: "pi_plugin_sources", profileName: "explorer", status: "completed",
		model: "sub2api/gpt-5.6-luna", effort: "max", startedAt: 0, completedAt: 189000, updatedAt: 189000,
		message: "SECRET PROMPT", finalOutput: "SECRET RESULT", stderr: "SECRET LOG", cwd: "/repo", tools: ["read"],
		activities: [{ id: "t", name: "read", kind: "tool", summary: "SECRET PATH", status: "completed", startedAt: 0 }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 }, display: DEFAULT_CONFIG.output, ...overrides };
}
function details(action: InlineDetails["action"] = "spawn", agent: InlineAgent = inlineAgent(snapshot())): InlineDetails {
	return { action, agents: [agent] };
}
function context(args: object = {}): InlineRenderContext {
	return { toolCallId: "tool_spawn", args, state: {}, invalidate() {} };
}
function rows(lines: string[]): string[] { return lines.map(stripVTControlCharacters).filter((line) => line.trim()); }

describe("compact inline subagent rendering", () => {
	it("includes actual effort in metadata without copying private child content", () => {
		const metadata = inlineAgent(snapshot());
		assert.equal(metadata.effort, "max"); assert.equal(metadata.model, "sub2api/gpt-5.6-luna");
		assert.doesNotMatch(JSON.stringify(metadata), /SECRET|finalOutput|stderr|summary/);
	});
	it("puts resolved profile, task, model and effort in one spawn heading", () => {
		const args = { task_name: "pi_plugin_sources", agent_type: "", model: "parent/wrong", reasoning_effort: "low", message: "SECRET PROMPT" };
		const ctx = context(args);
		const call = renderInlineCall("spawn", args, theme, undefined, ctx);
		assert.deepEqual(call.render(160), ["● Spawn agent (pi_plugin_sources)"]);
		const result = renderInlineResult(details(), false, theme, undefined, ctx);
		assert.deepEqual(result.render(160), []);
		assert.deepEqual(call.render(160), [expected]);
		assert.doesNotMatch(call.render(160).join("\n"), /⎿|tools|Completed|3m|wrong|low|SECRET/);
	});
	it("preserves off, and omits unavailable effort in old persisted results", () => {
		const off = renderInlineResult(details("spawn", inlineAgent(snapshot({ effort: "off" }))), false, theme);
		assert.match(off.render(160)[0], /gpt-5\.6-luna off\)$/);
		const legacy = inlineAgent(snapshot()); delete legacy.effort;
		const ctx = context({ reasoning_effort: "high" });
		renderInlineResult(details("spawn", legacy), false, theme, undefined, ctx);
		const rendered = renderInlineCall("spawn", {}, theme, undefined, ctx).render(160)[0];
		assert.match(rendered, /gpt-5\.6-luna\)$/); assert.doesNotMatch(rendered, /undefined|inherit|high/);
	});
	it("refreshes resolved metadata by agent ID without following reused task names", () => {
		const store = new InlineAgentStore();
		const ctx = context(); let invalidations = 0; ctx.invalidate = () => { invalidations++; };
		try {
			const original = snapshot({ status: "running", completedAt: undefined, effort: undefined }); store.accept(original);
			const call = renderInlineCall("spawn", {}, theme, store, ctx);
			renderInlineResult(details("spawn", inlineAgent(original)), false, theme, store, ctx);
			store.accept(snapshot()); assert.ok(invalidations > 0); assert.deepEqual(call.render(160), [expected]);
			store.accept(snapshot({ id: "agent_reused", model: "another/model", effort: "low" }));
			assert.deepEqual(call.render(160), [expected]);
		} finally { store.dispose(); }
	});
	it("keeps spawn errors visible without a nested connector or private result body", () => {
		const ctx = context();
		const call = renderInlineCall("spawn", { task_name: "bad_task" }, theme, undefined, ctx);
		renderInlineResult({ action: "spawn", agents: [], message: "Configured model is unavailable.\nCheck settings." }, false, theme, undefined, ctx);
		const rendered = call.render(200);
		assert.equal(rendered.length, 1); assert.match(rendered[0], /Spawn agent \(bad_task\).*Failed: Configured model/);
		assert.doesNotMatch(rendered[0], /⎿/);
	});
	it("keeps spawn headings on one safe visual row even on narrow terminals", () => {
		const data = details("spawn", inlineAgent(snapshot({ taskName: "任务\n\u001b[31msources" })));
		const component = renderInlineResult(data, false, theme);
		for (const width of [0, 1, 12, 32, 80, 160]) {
			const lines = component.render(width); assert.equal(lines.length, width ? 1 : 0);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join(""), /\u001b|\n|⎿/);
		}
	});
	it("omits model, effort and tool counts from partial, finished and timed-out wait rows", () => {
		for (const status of ["running", "completed", "errored"] as const) {
			for (const partial of [true, false]) {
				for (const timedOut of [false, true]) {
					const data = { ...details("wait", inlineAgent(snapshot({ status }))), timedOut, snapshots: [snapshot()] };
					const rendered = renderInlineResult(data, partial, theme).render(200).join("\n");
					assert.match(rendered, /explorer · pi_plugin_sources/); assert.match(rendered, /3m 9s/);
					assert.doesNotMatch(rendered, /sub2api|gpt-5\.6|\bmax\b|\d+ tools|SECRET/);
					assert.match(rendered, partial ? /Waiting for a new result/ : timedOut ? /wait deadline reached/ : /Wait finished/);
				}
			}
		}
	});
	it("retains the existing metadata for send, close and list actions", () => {
		for (const action of ["send", "close", "list"] as const) {
			const rendered = renderInlineResult(details(action), false, theme).render(200).join("\n");
			assert.match(rendered, /1 tools/); assert.match(rendered, /sub2api\/gpt-5\.6-luna/);
		}
	});
	it("renders exactly one heading through the registered tool and native Pi composition, even expanded", () => {
		type Renderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
		const tools = new Map<string, Renderers>();
		const previous = process.env.PI_SIMPLE_SUBAGENT_CHILD; delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
		try {
			simpleSubagentExtension({ registerTool(tool: Renderers & { name: string }) { tools.set(tool.name, tool); }, registerCommand() {}, on() {} } as never);
		} finally { if (previous === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CHILD; else process.env.PI_SIMPLE_SUBAGENT_CHILD = previous; }
		const tui = { terminal: { columns: 160, rows: 40 }, requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("spawn_agent", "native_spawn", { task_name: "pi_plugin_sources", agent_type: "", model: "parent/wrong", reasoning_effort: "low", message: "SECRET PROMPT" }, { showImages: false }, tools.get("spawn_agent"), tui, "/repo");
		component.setArgsComplete(); component.markExecutionStarted();
		assert.deepEqual(rows(component.render(160)), ["● Spawn agent (pi_plugin_sources)"]);
		component.updateResult({ content: [{ type: "text", text: "SECRET RESULT" }], details: details(), isError: false }, false);
		for (const expanded of [false, true, false]) {
			component.setExpanded(expanded);
			assert.deepEqual(rows(component.render(160)), [expected]);
		}
		const waiting = new ToolExecutionComponent("wait_agent", "native_wait", { ids: ["agent_first"] }, { showImages: false }, tools.get("wait_agent"), tui, "/repo");
		waiting.markExecutionStarted();
		for (const partial of [true, false]) {
			waiting.updateResult({ content: [{ type: "text", text: "SECRET RESULT" }], details: details("wait"), isError: false }, partial);
			waiting.setExpanded(true);
			const rendered = rows(waiting.render(160)).join("\n");
			assert.match(rendered, /Waiting for subagents/); assert.match(rendered, /Completed · 3m 9s/);
			assert.doesNotMatch(rendered, /SECRET|sub2api|gpt-5\.6|\bmax\b|\d+ tools/);
		}
	});
});
