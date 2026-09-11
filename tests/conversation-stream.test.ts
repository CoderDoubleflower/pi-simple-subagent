import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ConversationMirror } from "../extensions/subagent/conversation-mirror.ts";
import { AgentConversation } from "../extensions/subagent/agent-conversation.ts";
import { AgentManager } from "../extensions/subagent/agent-manager.ts";
import { normalizeConfig } from "../extensions/subagent/config.ts";

const start = { role: "assistant", timestamp: 2, content: [] };
function delta(mirror: ConversationMirror, type: string, index: number, extra: Record<string, unknown> = {}) {
	mirror.accept({ type: "message_update", assistantMessageEvent: { type, contentIndex: index, ...extra } });
}
describe("structured child wire transcript", () => {
	it("reconstructs text and thinking before message_end without message or partial snapshots", () => {
		const mirror = new ConversationMirror(); mirror.accept({ type: "message_start", message: start });
		delta(mirror, "thinking_start", 0); delta(mirror, "thinking_delta", 0, { delta: "Checking " }); delta(mirror, "thinking_delta", 0, { delta: "the code" });
		delta(mirror, "text_start", 1); delta(mirror, "text_delta", 1, { delta: "**Live " }); delta(mirror, "text_delta", 1, { delta: "answer**" });
		assert.equal(mirror.items.length, 1); assert.equal(mirror.items[0].streaming, true);
		assert.deepEqual(mirror.items[0].message.content, [{ type: "thinking", thinking: "Checking the code" }, { type: "text", text: "**Live answer**" }]);
		mirror.accept({ type: "message_end", message: { ...start, content: [{ type: "thinking", thinking: "Final reasoning" }, { type: "text", text: "Final answer" }] } });
		assert.equal(mirror.items.length, 1); assert.equal(mirror.items[0].streaming, false);
		assert.match(JSON.stringify(mirror.items), /Final reasoning/); assert.doesNotMatch(JSON.stringify(mirror.items), /Live answer/);
	});
	it("retains tool arguments, result text and diff details in the private view", () => {
		const mirror = new ConversationMirror(); mirror.accept({ type: "message_start", message: start });
		delta(mirror, "toolcall_start", 0, { id: "tool", toolName: "edit" });
		delta(mirror, "toolcall_delta", 0, { delta: '{"path":"src/' }); delta(mirror, "toolcall_delta", 0, { delta: 'auth.ts"}' });
		delta(mirror, "toolcall_end", 0, { toolCall: { id: "tool", name: "edit", arguments: { path: "src/auth.ts", oldText: "false", newText: "true" } } });
		const partial = mirror.streamingMessage!;
		mirror.accept({ type: "message_end", message: partial });
		mirror.accept({ type: "tool_execution_start", toolCallId: "tool", toolName: "edit", args: partial.content[0].arguments });
		mirror.accept({ type: "tool_execution_end", toolCallId: "tool", toolName: "edit", result: { content: [{ type: "text", text: "Changed file" }], details: { diff: "- false\n+ true" } } });
		mirror.accept({ type: "message_end", message: { role: "toolResult", toolCallId: "tool", toolName: "edit", content: [{ type: "text", text: "Changed file" }], details: { diff: "- false\n+ true" } } });
		assert.equal(mirror.items.filter((item) => item.message.role === "toolResult").length, 1);
		assert.match(JSON.stringify(mirror.items), /Changed file/); assert.match(JSON.stringify(mirror.items), /oldText/); assert.match(JSON.stringify(mirror.items), /diff/);
	});
	it("does not roll completed history back to buffered partial updates", () => {
		const final = { ...start, content: [{ type: "text", text: "authoritative" }, { type: "thinking", thinking: "complete" }] };
		const mirror = new ConversationMirror(); mirror.replace([final]);
		mirror.accept({ type: "message_start", message: start }); delta(mirror, "text_delta", 0, { delta: "obsolete" });
		assert.equal(mirror.items.length, 1); assert.match(JSON.stringify(mirror.items), /authoritative/); assert.doesNotMatch(JSON.stringify(mirror.items), /obsolete/);
		mirror.accept({ type: "message_end", message: final }); assert.equal(mirror.items.length, 1);
	});
	it("keeps final tool output when buffered earlier progress is replayed", () => {
		const mirror = new ConversationMirror();
		mirror.replace([{ role: "toolResult", toolCallId: "tool", toolName: "read", content: "final file" }]);
		mirror.accept({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: { path: "src/file" } });
		mirror.accept({ type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "obsolete" }] } });
		assert.equal(mirror.items.length, 1); assert.match(JSON.stringify(mirror.items), /final file/); assert.doesNotMatch(JSON.stringify(mirror.items), /obsolete/);
	});
	it("supports cumulative legacy events and retains interrupted partial text", () => {
		const mirror = new ConversationMirror();
		mirror.accept({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "must not double", partial: { ...start, content: [{ type: "text", text: "legacy" }] } } });
		assert.equal(mirror.items[0].message.content[0].text, "legacy");
		mirror.accept({ type: "agent_settled" }); assert.equal(mirror.items[0].streaming, false); assert.match(JSON.stringify(mirror.items), /legacy/);
	});
	it("sanitizes private display data without editing actual messages or retaining image/signature payloads", () => {
		const source = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "\u001b[31mThinking\u001b[0m", thinkingSignature: "signature_blob" }, { type: "image", data: "image_blob" }] };
		const original = JSON.stringify(source), mirror = new ConversationMirror(); mirror.replace([source]);
		assert.equal(JSON.stringify(source), original); assert.match(JSON.stringify(mirror.items), /Thinking/);
		assert.doesNotMatch(JSON.stringify(mirror.items), /signature_blob|image_blob|\\u001b/);
	});
	it("joins a running RPC child with its already-received thinking and text, then continues the same context", { timeout: 10000 }, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-wire-"));
		const manager = new AgentManager(normalizeConfig({ model: "p/child", killGraceMs: 100, killForceMs: 100,
			process: { command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))] } }));
		const conversation = new AgentConversation(manager, (target, text, interrupt) => manager.sendInput(target, text, interrupt), () => {});
		try {
			const child = await manager.spawn({ taskName: "wire", message: "[wire-stream] [delay=800]" }, { cwd, model: "p/child", tools: ["read"], projectTrusted: true });
			await conversation.select(child.id);
			// get_messages contains only committed history; the seeded current stream must fill the gap.
			assert.equal(conversation.snapshot?.status, "running");
			assert.match(JSON.stringify(conversation.mirror.items), /Checking the delegated scope/);
			assert.match(JSON.stringify(conversation.mirror.items), /Live answer/);
			assert.equal(conversation.mirror.items.some((item) => item.streaming), true);
			await manager.wait([child.id], 2000);
			assert.equal(conversation.mirror.items.filter((item) => item.message.role === "assistant").length, 1);
			assert.equal(conversation.mirror.items.some((item) => item.streaming), false);
			assert.match(JSON.stringify(conversation.mirror.items), /authenticated/);
			await conversation.send("continue in the same context", false); await manager.wait([child.id], 2000);
			assert.equal(manager.list().length, 1); assert.match(JSON.stringify(conversation.mirror.items), /turn 2: continue/);
			conversation.leave(); assert.equal(manager.list().length, 1);
		} finally { conversation.dispose(); await manager.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); }
	});
});
