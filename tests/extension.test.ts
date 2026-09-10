import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import simpleSubagentExtension from "../extensions/subagents.ts";
import type { InlineDetails } from "../extensions/subagent/inline-rendering.ts";

interface Result { content: Array<{ text: string }>; details: InlineDetails; isError?: boolean }
interface RegisteredTool {
	name: string; renderShell?: string;
	renderCall(args: Record<string, unknown>, theme: Theme): { render(width: number): string[] };
	renderResult(result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme): { render(width: number): string[] };
	execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((result: unknown) => void) | undefined, ctx: ExtensionContext): Promise<Result>;
}
const originalChildFlag = process.env.PI_SIMPLE_SUBAGENT_CHILD;
const originalConfig = process.env.PI_SIMPLE_SUBAGENT_CONFIG;
const cleanups: Array<() => Promise<void>> = [], dirs: string[] = [];
const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (originalChildFlag === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CHILD; else process.env.PI_SIMPLE_SUBAGENT_CHILD = originalChildFlag;
	if (originalConfig === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CONFIG; else process.env.PI_SIMPLE_SUBAGENT_CONFIG = originalConfig;
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function harness() {
	const tools: RegisteredTool[] = [], commands: string[] = [], messages: Array<Record<string, unknown>> = [];
	const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const commandHandlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.push(name); commandHandlers.set(name, command.handler); },
		on(name: string, fn: (event: never, ctx: ExtensionContext) => unknown) { hooks.set(name, fn); },
		getActiveTools() { return ["read"]; }, getAllTools() { return []; },
		sendMessage(message: Record<string, unknown>) { messages.push(message); },
	};
	return { pi, tools, commands, hooks, messages, commandHandlers };
}
function setup(overrides: Record<string, unknown> = {}) {
	delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-extension-")); dirs.push(dir);
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, JSON.stringify({ defaultProfile: "explorer", profiles: { custom: { description: "Custom profile available before spawn" } },
		process: { command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))] }, killGraceMs: 100, killForceMs: 100, ...overrides }));
	process.env.PI_SIMPLE_SUBAGENT_CONFIG = configPath;
	const h = harness(); simpleSubagentExtension(h.pi as never);
	const notices: string[] = [];
	const ctx = { cwd: dir, hasUI: false, mode: "rpc", isProjectTrusted: () => true,
		model: { provider: "openai", id: "parent-model" }, ui: { notify(text: string) { notices.push(text); }, setWidget() { assert.fail("Must not mount a spinner panel"); } }, thinkingLevel: "medium" } as unknown as ExtensionContext;
	const hook = async (name: string, event: unknown = {}) => h.hooks.get(name)?.(event as never, ctx);
	cleanups.push(async () => { await hook("session_shutdown"); });
	const call = async (name: string, params: Record<string, unknown>, update?: (result: unknown) => void) => h.tools.find((tool) => tool.name === name)!.execute(name, params, undefined, update, ctx);
	return { ...h, ctx, hook, call, dir, notices };
}
describe("extension entry point", () => {
	it("registers inline English tools, one configuration command, and the agents view", () => {
		delete process.env.PI_SIMPLE_SUBAGENT_CHILD; const h = harness(); simpleSubagentExtension(h.pi as never);
		assert.deepEqual(h.tools.map((tool) => tool.name), ["spawn_agent", "send_input", "wait_agent", "close_agent", "list_agents"]);
		assert.deepEqual(h.commands, ["subagent-config", "agents"]);
		for (const hook of ["session_start", "session_shutdown", "session_tree", "before_agent_start", "context", "tool_call", "tool_execution_end", "agent_end"]) assert.ok(h.hooks.has(hook));
		for (const tool of h.tools) { assert.equal(tool.renderShell, "self"); assert.ok(tool.renderCall({}, theme).render(80).length > 0); }
		assert.match(h.tools.find((tool) => tool.name === "wait_agent")!.renderCall({}, theme).render(80).join("\n"), /Waiting for subagents/);
	});
	it("does not register orchestration inside child processes", () => {
		process.env.PI_SIMPLE_SUBAGENT_CHILD = "1"; const h = harness(); simpleSubagentExtension(h.pi as never);
		assert.deepEqual(h.tools, []); assert.deepEqual(h.commands, []); assert.equal(h.hooks.size, 0);
	});
	it("loads actual profiles and configured model guidance before the first request", async () => {
		const h = setup({ model: "openai/child-model" }); await h.hook("session_start");
		const response = await h.hook("before_agent_start", { systemPrompt: "BASE" }) as { systemPrompt: string };
		assert.match(response.systemPrompt, /defaultProfile="explorer"/); assert.match(response.systemPrompt, /Custom profile available before spawn/);
		assert.match(response.systemPrompt, /openai\/child-model/);
	});
	it("configured child model overrides a model-authored parent-model argument", async () => {
		const h = setup({ model: "openai/configured-child" }); await h.hook("session_start");
		const spawned = await h.call("spawn_agent", { task_name: "model_test", message: "first", model: "openai/parent-model" });
		assert.equal(spawned.isError, false, spawned.content[0].text);
		const value = JSON.parse(spawned.content[0].text);
		assert.equal(value.model, "openai/configured-child"); assert.equal(value.model_source, "config");
		assert.equal(value.ignored_model_override, "openai/parent-model");
		assert.equal(spawned.details.agents[0].model, value.model);
	});
	it("profile model remains more specific than the root setting", async () => {
		const h = setup({ model: "openai/root", profiles: { explorer: { model: "openai/profile" } } }); await h.hook("session_start");
		const spawned = await h.call("spawn_agent", { task_name: "profile_test", message: "first", model: "openai/parent-model" });
		assert.equal(spawned.isError, false, spawned.content[0].text);
		assert.equal(JSON.parse(spawned.content[0].text).model, "openai/profile");
	});
	it("returns child output to the model while displaying only metadata and a visible wait", { timeout: 10000 }, async () => {
		const h = setup(); await h.hook("session_start");
		const spawned = await h.call("spawn_agent", { task_name: "real_rpc", message: "private child task [delay=100]", agent_type: "" });
		assert.equal(spawned.isError, false, spawned.content[0].text); const id = JSON.parse(spawned.content[0].text).agent_id;
		const updates: unknown[] = [];
		const waited = await h.call("wait_agent", { ids: [id] }, (value) => updates.push(value)); assert.equal(waited.isError, false);
		assert.equal(updates.length, 1); assert.match(JSON.stringify(updates), /Waiting for subagents/);
		const outputs = JSON.parse(waited.content[0].text).results as Array<{ output?: string }>;
		await new Promise((resolve) => setTimeout(resolve, 30));
		const notified = h.messages.flatMap((message) => (JSON.parse(String(message.content)).results as Array<{ output?: string }>));
		assert.deepEqual([...outputs, ...notified].map((item) => item.output), ["turn 1: private child task [delay=100]"]);
		assert.ok(h.messages.every((message) => message.display === false));
		assert.doesNotMatch(JSON.stringify(waited.details), /private child task|finalOutput|stderr|message/);
		const rendered = h.tools.find((tool) => tool.name === "wait_agent")!.renderResult(waited, { expanded: true, isPartial: false }, theme).render(160).join("\n");
		assert.match(rendered, /Completed/); assert.doesNotMatch(rendered, /private child task/);
		assert.deepEqual(JSON.parse((await h.call("wait_agent", { ids: [id] })).content[0].text).results, []);
	});
	it("does not open the interactive agents view for an RPC parent", async () => {
		const h = setup(); await h.hook("session_start"); await h.commandHandlers.get("agents")!("", h.ctx);
		assert.match(h.notices.join("\n"), /requires an interactive TUI/);
	});
});
