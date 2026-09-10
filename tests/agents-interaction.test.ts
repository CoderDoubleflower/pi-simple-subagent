import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../extensions/subagent/agent-manager.ts";
import { AgentConversation } from "../extensions/subagent/agent-conversation.ts";
import { ConversationMirror } from "../extensions/subagent/conversation-mirror.ts";
import { InteractionGate } from "../extensions/subagent/interaction-gate.ts";
import { InlineAgentStore, inlineAgent } from "../extensions/subagent/inline-store.ts";
import { renderInlineCall, renderInlineResult, type InlineRenderContext } from "../extensions/subagent/inline-rendering.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../extensions/subagent/config.ts";
import type { AgentSnapshot } from "../extensions/subagent/types.ts";

const managers: AgentManager[] = [], dirs: string[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
function snapshot(): AgentSnapshot {
	return { id: "id", taskName: "inspect", profileName: "explorer", status: "running", model: "p/child", message: "SECRET PROMPT", finalOutput: "SECRET RESULT", stderr: "SECRET LOG",
		tools: ["read"], cwd: "/repo", startedAt: Date.now(), updatedAt: Date.now(), activities: [], display: DEFAULT_CONFIG.output,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 } };
}
function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agents-interaction-")); dirs.push(cwd);
	const commandFile = path.join(cwd, "commands");
	const config = normalizeConfig({ ...DEFAULT_CONFIG, rpcStartupTimeoutMs: 2000, killGraceMs: 100, killForceMs: 100,
		process: { ...DEFAULT_CONFIG.process, command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))], env: { FAKE_PI_COMMANDS_FILE: commandFile } } });
	const manager = new AgentManager(config); managers.push(manager);
	return { manager, parent: { cwd, model: "p/child", tools: ["read"], projectTrusted: true },
		commands: () => fs.readFileSync(commandFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}
describe("agents interaction", () => {
	it("holds parent tools while a child view is open and releases on return", async () => {
		const gate = new InteractionGate(); const release = gate.enter(); let called = false;
		const wait = gate.wait().then(() => { called = true; });
		await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(called, false);
		release(); release(); await wait; assert.equal(called, true); gate.dispose();
	});
	it("cancels gate waits and rejects stale session use", async () => {
		const gate = new InteractionGate(); gate.enter(); const abort = new AbortController();
		const wait = assert.rejects(gate.wait(abort.signal), /closed/); abort.abort(); await wait;
		const pending = assert.rejects(gate.wait(), /closed/); gate.dispose(); await pending;
		await assert.rejects(gate.wait(), /closed/); assert.throws(() => gate.enter(), /closed/);
	});
	it("deduplicates snapshot/event overlap and streams text without thinking/tool bodies", () => {
		const mirror = new ConversationMirror();
		const user = { role: "user", timestamp: 1, content: [{ type: "text", text: "question" }] };
		mirror.replace([user]); mirror.accept({ type: "message_end", message: user }); assert.equal(mirror.messages.length, 1);
		mirror.accept({ type: "message_update", message: { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "SECRET THINKING" }, { type: "text", text: "streaming" }] } });
		assert.equal(mirror.messages.length, 2);
		mirror.accept({ type: "message_end", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "finished" }] } });
		mirror.accept({ type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "t", content: [{ type: "text", text: "SECRET FILE" }] } });
		assert.equal(mirror.messages.length, 3); assert.doesNotMatch(JSON.stringify(mirror.messages), /SECRET|streaming/);
	});
	it("bounds and sanitizes its display cache without modifying child context", () => {
		const mirror = new ConversationMirror();
		mirror.replace(Array.from({ length: 500 }, (_, i) => ({ role: "user", timestamp: i, content: [{ type: "text", text: `\u001b[31mmessage ${i}\u001b[0m` }] })));
		assert.ok(mirror.messages.length <= 200); assert.doesNotMatch(JSON.stringify(mirror.messages), /\\u001b/);
	});
	it("reads and continues the same RPC conversation without spawning or switching sessions", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "context", message: "original context" }, h.parent);
		await h.manager.wait([s.id], 2000);
		const view = new AgentConversation(h.manager, (target, text, interrupt) => h.manager.sendInput(target, text, interrupt), () => {});
		try {
			await view.select(s.id); assert.match(JSON.stringify(view.mirror.messages), /original context/);
			await view.send("continue with that context", false); await h.manager.wait([s.id], 2000);
			assert.match(JSON.stringify(view.mirror.messages), /turn 2: continue with that context/);
			assert.equal(h.manager.list().length, 1); assert.equal(h.manager.list()[0].id, s.id);
			assert.equal(h.commands().some((c) => ["new_session", "switch_session", "fork"].includes(String(c.type))), false);
		} finally { view.dispose(); }
		assert.equal(h.manager.list().length, 1, "closing a view must not close its child");
	});
	it("queues follow-ups and steers the existing running child", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "running", message: "original [delay=200]" }, h.parent);
		const view = new AgentConversation(h.manager, (target, text, interrupt) => h.manager.sendInput(target, text, interrupt), () => {});
		try {
			await view.select(s.id); await view.send("queued", false); await view.send("steering", true);
			await h.manager.wait([s.id], 2000);
			assert.ok(h.commands().some((c) => c.type === "follow_up" && c.message === "queued"));
			assert.ok(h.commands().some((c) => c.type === "steer" && c.message === "steering"));
			const history = JSON.stringify(await h.manager.getMessages(s.id)); assert.match(history, /queued/); assert.match(history, /steering/);
		} finally { view.dispose(); }
	});
	it("rejects slash commands and does not route prompts after leaving a context", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "commands", message: "first" }, h.parent);
		const view = new AgentConversation(h.manager, (target, text, interrupt) => h.manager.sendInput(target, text, interrupt), () => {});
		try {
			await view.select(s.id); await assert.rejects(view.send("/new", false), /not child slash commands/);
			view.leave(); await assert.rejects(view.send("wrong target", false), /No agent selected/);
			assert.equal(h.commands().some((c) => c.message === "/new" || c.message === "wrong target"), false);
		} finally { view.dispose(); }
	});
	it("discards a stale initial history response after switching views", async () => {
		let resolve!: (messages: unknown[]) => void; let events = 0, subscriptions = 0;
		const manager = { list: () => [snapshot()], subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
			subscribeEvents: () => { events++; return () => { events--; }; }, getMessages: () => new Promise<unknown[]>((r) => { resolve = r; }) };
		const view = new AgentConversation(manager, async () => {}, () => {});
		const pending = view.select("id"); view.leave(); resolve([{ role: "user", content: "stale" }]); await pending;
		assert.equal(view.selected, undefined); assert.deepEqual(view.mirror.messages, []); assert.equal(events, 0);
		view.dispose(); assert.equal(subscriptions, 0);
	});
	it("uses English inline metadata only, including expanded legacy details", () => {
		const s = snapshot(); const store = new InlineAgentStore(); store.accept(s);
		try {
			const details = { action: "wait" as const, agents: [inlineAgent(s)], snapshots: [s] };
			const text = renderInlineResult(details, true, theme, store).render(160).join("\n");
			assert.match(text, /Waiting for a new result/); assert.match(text, /Running/); assert.match(text, /p\/child/); assert.doesNotMatch(text, /SECRET/);
			assert.match(renderInlineCall("wait", { message: "SECRET" }, theme).render(80).join("\n"), /Waiting for subagents/);
		} finally { store.dispose(); }
	});
	it("updates transcript rows from local events and disposes callbacks", () => {
		const store = new InlineAgentStore(); const s = snapshot(); store.accept(s); let invalidated = 0;
		const context: InlineRenderContext = { toolCallId: "call", invalidate() { invalidated++; } };
		renderInlineResult({ action: "spawn", agents: [inlineAgent(s)] }, false, theme, store, context);
		store.accept({ ...s, status: "completed" }); assert.equal(invalidated, 1);
		store.dispose(); store.accept(s); assert.equal(invalidated, 1);
	});
});
