import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import simpleSubagentExtension from "../extensions/subagents.ts";

interface RegisteredTool {
	name: string; renderShell?: string;
	renderCall(): { render(width: number): string[] };
	renderResult(): { render(width: number): string[] };
	execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}
const originalChildFlag = process.env.PI_SIMPLE_SUBAGENT_CHILD;
const originalConfig = process.env.PI_SIMPLE_SUBAGENT_CONFIG;
const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (originalChildFlag === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CHILD; else process.env.PI_SIMPLE_SUBAGENT_CHILD = originalChildFlag;
	if (originalConfig === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CONFIG; else process.env.PI_SIMPLE_SUBAGENT_CHILD = originalChildFlag;
	if (originalConfig === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CONFIG; else process.env.PI_SIMPLE_SUBAGENT_CONFIG = originalConfig;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function harness() {
	const tools: RegisteredTool[] = []; const commands: string[] = []; const messages: Array<Record<string, unknown>> = [];
	const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); }, registerCommand(name: string) { commands.push(name); },
		on(name: string, fn: (event: never, ctx: ExtensionContext) => unknown) { hooks.set(name, fn); },
		getActiveTools() { return ["read"]; }, getAllTools() { return []; },
		sendMessage(message: Record<string, unknown>) { messages.push(message); },
	};
	return { pi, tools, commands, hooks, messages };
}
function setup() {
	delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-extension-")); dirs.push(dir);
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, JSON.stringify({ defaultProfile: "explorer", profiles: { custom: { description: "Custom profile available before spawn" } },
		process: { command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))] }, killGraceMs: 100, killForceMs: 100 }));
	process.env.PI_SIMPLE_SUBAGENT_CONFIG = configPath;
	const state = harness(); simpleSubagentExtension(state.pi as never);
	const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} }, thinkingLevel: "medium" } as unknown as ExtensionContext;
	const hook = async (name: string, event: unknown = {}) => state.hooks.get(name)?.(event as never, ctx);
	cleanups.push(async () => { await hook("session_shutdown"); });
	const call = async (name: string, params: Record<string, unknown>) => state.tools.find((tool) => tool.name === name)!.execute(name, params, undefined, undefined, ctx);
	return { ...state, ctx, hook, call };
}
describe("extension entry point", () => {
	it("registers five hidden tools, one config command and the required lifecycle hooks", () => {
		delete process.env.PI_SIMPLE_SUBAGENT_CHILD; const h = harness(); simpleSubagentExtension(h.pi as never);
		assert.deepEqual(h.tools.map((tool) => tool.name), ["spawn_agent", "send_input", "wait_agent", "close_agent", "list_agents"]);
		assert.deepEqual(h.commands, ["subagent-config"]);
		for (const hook of ["session_start", "session_shutdown", "session_tree", "before_agent_start", "context", "tool_call", "tool_execution_end", "agent_end"]) assert.ok(h.hooks.has(hook));
		for (const tool of h.tools) { assert.equal(tool.renderShell, "self"); assert.deepEqual(tool.renderCall().render(80), []); assert.deepEqual(tool.renderResult().render(80), []); }
	});
	it("does not register orchestration inside child processes", () => {
		process.env.PI_SIMPLE_SUBAGENT_CHILD = "1"; const h = harness(); simpleSubagentExtension(h.pi as never);
		assert.deepEqual(h.tools, []); assert.deepEqual(h.commands, []); assert.equal(h.hooks.size, 0);
	});
	it("loads the actual profiles before the first model request", async () => {
		const h = setup(); await h.hook("session_start");
		const response = await h.hook("before_agent_start", { systemPrompt: "BASE" }) as { systemPrompt: string };
		assert.match(response.systemPrompt, /defaultProfile="explorer"/); assert.match(response.systemPrompt, /Custom profile available before spawn/);
	});
	it("delivers real RPC child output to the model without exposing renderer details", { timeout: 10000 }, async () => {
		const h = setup(); await h.hook("session_start");
		const spawned = await h.call("spawn_agent", { task_name: "real_rpc", message: "first", agent_type: "" });
		assert.equal(spawned.isError, false); const id = JSON.parse(spawned.content[0].text).agent_id;
		const waited = await h.call("wait_agent", { ids: [id] }); assert.equal(waited.isError, false);
		const outputs = JSON.parse(waited.content[0].text).results as Array<{ output?: string }>;
		await new Promise((resolve) => setTimeout(resolve, 30));
		const notified = h.messages.flatMap((message) => (JSON.parse(String(message.content)).results as Array<{ output?: string }>));
		assert.deepEqual([...outputs, ...notified].map((item) => item.output), ["turn 1: first"]);
		assert.deepEqual(waited.details, {}); assert.ok(h.messages.every((message) => message.display === false));
		assert.deepEqual(JSON.parse((await h.call("wait_agent", { ids: [id] })).content[0].text).results, []);
	});
});
