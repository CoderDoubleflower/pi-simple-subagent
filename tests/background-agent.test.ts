import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../extensions/subagent/agent-manager.ts";
import { AgentProcess } from "../extensions/subagent/agent-process.ts";
import { InlineAgentStore, inlineAgent } from "../extensions/subagent/inline-store.ts";
import { renderInlineCall, renderInlineResult, safeLine, type InlineRenderContext } from "../extensions/subagent/inline-rendering.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../extensions/subagent/config.ts";
import type { AgentSnapshot } from "../extensions/subagent/types.ts";

const managers: AgentManager[] = [], dirs: string[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
function snapshot(): AgentSnapshot {
	return { id: "id", taskName: "inspect", profileName: "explorer", status: "running", model: "p/child", effort: "high", message: "SECRET PROMPT", finalOutput: "SECRET RESULT", stderr: "SECRET LOG",
		tools: ["read"], cwd: "/repo", startedAt: Date.now(), updatedAt: Date.now(), activities: [], display: DEFAULT_CONFIG.output,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 } };
}
function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "background-agent-")); dirs.push(cwd);
	const commandFile = path.join(cwd, "commands");
	const config = normalizeConfig({ ...DEFAULT_CONFIG, rpcStartupTimeoutMs: 2000, killGraceMs: 100, killForceMs: 100,
		process: { ...DEFAULT_CONFIG.process, command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))], env: { FAKE_PI_COMMANDS_FILE: commandFile } } });
	const manager = new AgentManager(config); managers.push(manager);
	return { manager, parent: { cwd, model: "p/child", effort: "high" as const, tools: ["read"], projectTrusted: true },
		commands: () => fs.readFileSync(commandFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}
describe("background-only agents", () => {
	it("removes the interactive view, mirrors and gate instead of only hiding the command", () => {
		const root = fileURLToPath(new URL("../extensions/", import.meta.url));
		for (const name of ["agents-view", "agent-conversation", "assistant-stream", "conversation-content", "conversation-mirror", "conversation-renderer", "interaction-gate"]) {
			assert.equal(fs.existsSync(path.join(root, "subagent", `${name}.ts`)), false, `${name} must be removed`);
		}
		function inspect(dir: string): void {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const name = path.join(dir, entry.name);
				if (entry.isDirectory()) inspect(name);
				else if (entry.name.endsWith(".ts")) assert.doesNotMatch(fs.readFileSync(name, "utf8"), /\/agents\b|InteractionGate|showAgentsView|ConversationMirror|AssistantStream|queuedCompletions|get_messages/, name);
			}
		}
		inspect(root);
		for (const prototype of [AgentManager.prototype, AgentProcess.prototype]) {
			assert.equal("getMessages" in prototype, false); assert.equal("subscribeEvents" in prototype, false);
		}
	});
	it("continues the same background RPC child without reading or opening its transcript", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "context", message: "original context" }, h.parent);
		await h.manager.wait([s.id], 2000);
		await h.manager.sendInput(s.id, "continue with that context", false);
		await h.manager.wait([s.id], 2000);
		const [child] = h.manager.list();
		assert.equal(h.manager.list().length, 1); assert.equal(child.id, s.id);
		assert.equal(child.finalOutput, "turn 2: continue with that context");
		assert.equal(child.model, "p/child"); assert.equal(child.effort, "high");
		assert.equal(h.commands().some((c) => ["get_messages", "new_session", "switch_session", "fork"].includes(String(c.type))), false);
	});
	it("keeps programmatic queue and steer operations working without a child view", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "running", message: "original [delay=300]" }, h.parent);
		await h.manager.sendInput(s.id, "queued", false);
		await h.manager.sendInput(s.id, "steering", true);
		await h.manager.wait([s.id], 2000);
		assert.ok(h.commands().some((c) => c.type === "follow_up" && c.message === "queued"));
		assert.ok(h.commands().some((c) => c.type === "steer" && c.message === "steering"));
		const [child] = h.manager.list();
		assert.equal(child.id, s.id); assert.equal(child.status, "completed");
		assert.equal(child.finalOutput, "turn 3: queued"); assert.equal(child.usage.turns, 3);
		assert.equal(h.commands().some((c) => c.type === "get_messages"), false);
	});
	it("still captures final results and usage from delta-only RPC streams without a live mirror", async () => {
		const h = fixture(); const s = await h.manager.spawn({ taskName: "wire", message: "[wire-stream] [delay=40]" }, h.parent);
		await h.manager.wait([s.id], 2000);
		const [child] = h.manager.list();
		assert.equal(child.status, "completed"); assert.match(child.finalOutput, /Live answer/);
		assert.doesNotMatch(child.finalOutput, /Checking the delegated scope|authenticated/);
		assert.equal(child.usage.turns, 1); assert.equal(child.activities[0].name, "read");
		assert.equal(child.activities[0].status, "completed");
		assert.equal(h.commands().some((c) => c.type === "get_messages"), false);
	});
	it("uses English inline metadata only, including expanded legacy details", () => {
		const s = snapshot(); const store = new InlineAgentStore(); store.accept(s);
		try {
			const details = { action: "wait" as const, agents: [inlineAgent(s)], snapshots: [s] };
			const text = renderInlineResult(details, true, theme, store).render(160).join("\n");
			assert.match(text, /Waiting for a new result/); assert.match(text, /Running/);
			assert.doesNotMatch(text, /SECRET|p\/child|tools|high/);
			assert.match(renderInlineCall("wait", { message: "SECRET" }, theme).render(80).join("\n"), /Waiting for subagents/);
		} finally { store.dispose(); }
	});
	it("updates inline metadata from local events and disposes callbacks", () => {
		const store = new InlineAgentStore(); const s = snapshot(); store.accept(s); let invalidated = 0;
		const context: InlineRenderContext = { toolCallId: "call", invalidate() { invalidated++; } };
		renderInlineResult({ action: "spawn", agents: [inlineAgent(s)] }, false, theme, store, context);
		store.accept({ ...s, status: "completed" }); assert.equal(invalidated, 1);
		store.dispose(); store.accept(s); assert.equal(invalidated, 1);
	});
	it("does not advertise the removed command in overflow hints", () => {
		const agents = Array.from({ length: 12 }, (_, i) => inlineAgent({ ...snapshot(), id: `id-${i}`, taskName: `task_${i}` }));
		for (const action of ["wait", "send", "close", "list"] as const) {
			const text = renderInlineResult({ action, agents }, false, theme).render(200).join("\n");
			assert.match(text, /\+4 more/); assert.doesNotMatch(text, /\/agents/);
		}
	});
	it("preserves metadata sanitization after removing the conversation helper", () => {
		assert.equal(safeLine("\u001b[31mTask\u001b[0m\n\tA\u0007"), "Task A");
		assert.equal(safeLine(undefined), ""); assert.equal(safeLine("abcdef", 3), "abc");
		assert.equal(safeLine("x".repeat(40000), 40000).length, 32768);
	});
});
