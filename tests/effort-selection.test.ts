import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeConfig } from "../extensions/subagent/config.ts";
import { selectDispatchEffort, verifyRpcEffort } from "../extensions/subagent/effort-selection.ts";
import simpleSubagentExtension from "../extensions/subagents.ts";

const originalConfig = process.env.PI_SIMPLE_SUBAGENT_CONFIG;
const originalChild = process.env.PI_SIMPLE_SUBAGENT_CHILD;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (originalConfig === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CONFIG; else process.env.PI_SIMPLE_SUBAGENT_CONFIG = originalConfig;
	if (originalChild === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CHILD; else process.env.PI_SIMPLE_SUBAGENT_CHILD = originalChild;
});
interface Tool {
	name: string;
	execute(id: string, params: Record<string, unknown>, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
async function fixture(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-effort-"));
	const configFile = path.join(cwd, "config.json"), logFile = path.join(cwd, "commands.jsonl");
	const config = { model: "p/child", effort: "low", profiles: { explorer: { effort: "high" } }, ...extra,
		process: { command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))], env: { FAKE_PI_COMMANDS_FILE: logFile, ...env } }, killGraceMs: 100, killForceMs: 100 };
	fs.writeFileSync(configFile, JSON.stringify(config)); process.env.PI_SIMPLE_SUBAGENT_CONFIG = configFile;
	delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
	const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const tools: Tool[] = [];
	const pi = { on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) { hooks.set(name, handler); },
		registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, getActiveTools: () => ["read"], sendMessage() {} };
	const ctx = { cwd, hasUI: false, mode: "rpc", model: { provider: "p", id: "parent" }, thinkingLevel: "medium", isProjectTrusted: () => true, ui: { notify() {} } } as unknown as ExtensionContext;
	simpleSubagentExtension(pi as never);
	const hook = (name: string, event: unknown = {}) => hooks.get(name)?.(event as never, ctx);
	cleanups.push(async () => { await hook("session_shutdown"); fs.rmSync(cwd, { recursive: true, force: true }); });
	await hook("session_start");
	return { configFile, config, hook,
		commands: () => fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
		call: async (name: string, params: Record<string, unknown>) => {
			const result = await tools.find((tool) => tool.name === name)!.execute(name, params, undefined, undefined, ctx);
			return { result, data: result.isError ? undefined : JSON.parse(result.content[0].text) as Record<string, unknown> };
		},
	};
}
describe("configured reasoning effort", () => {
	it("prefers the selected profile over root, request and parent", () => {
		const config = normalizeConfig({ effort: "low", defaultProfile: "explorer", profiles: { explorer: { effort: "high" } } });
		assert.deepEqual(selectDispatchEffort(config, "", "minimal", "medium"), { effort: "high", source: "profile", ignoredOverride: "minimal" });
		assert.deepEqual(selectDispatchEffort(config, "explorer", "high", "max"), { effort: "high", source: "profile" });
	});
	it("preserves explicit off and only inherits when configured to do so", () => {
		assert.deepEqual(selectDispatchEffort(normalizeConfig({ effort: "off" }), undefined, "high", "max"), { effort: "off", source: "config", ignoredOverride: "high" });
		assert.equal(selectDispatchEffort(normalizeConfig({ effort: "max", profiles: { reviewer: { effort: "off" } } }), "reviewer", "high").effort, "off");
		const config = normalizeConfig({});
		assert.deepEqual(selectDispatchEffort(config, undefined, "low", "high"), { effort: "low", source: "request" });
		assert.deepEqual(selectDispatchEffort(config, undefined, undefined, "high"), { effort: "high", source: "parent" });
		assert.deepEqual(selectDispatchEffort(config, undefined), { effort: undefined, source: "child-default" });
	});
	it("rejects missing or mismatching effective levels", async () => {
		assert.equal(await verifyRpcEffort(async () => ({ thinkingLevel: "off" }), "off"), "off");
		assert.equal(await verifyRpcEffort(async () => ({ thinkingLevel: "max" })), "max");
		await assert.rejects(verifyRpcEffort(async () => ({}), "high"), /did not report/);
		await assert.rejects(verifyRpcEffort(async () => ({ thinkingLevel: "medium" }), "high"), /effort mismatch/);
	});
	it("protects profile effort through the actual model-facing tool and verifies RPC before prompt", async () => {
		const h = await fixture();
		const { result, data } = await h.call("spawn_agent", { task_name: "profile", message: "inspect", agent_type: "explorer", reasoning_effort: "low" });
		assert.equal(result.isError, false); assert.equal(data?.reasoning_effort, "high"); assert.equal(data?.effort_source, "profile"); assert.equal(data?.ignored_effort_override, "low");
		const commands = h.commands();
		assert.equal(commands.find((command) => command.type === "set_thinking_level")?.level, "high");
		assert.ok(commands.findIndex((command) => command.type === "get_state") < commands.findIndex((command) => command.type === "prompt"));
		const guidance = await h.hook("before_agent_start", { systemPrompt: "BASE" }) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /User-configured child reasoning efforts/); assert.match(guidance.systemPrompt, /"explorer":"high"/);
	});
	it("protects a top-level off setting over model-authored high", async () => {
		const h = await fixture({ effort: "off", profiles: { explorer: { effort: "inherit" } } });
		const { result, data } = await h.call("spawn_agent", { task_name: "off", message: "inspect", agent_type: "explorer", reasoning_effort: "high" });
		assert.equal(result.isError, false); assert.equal(data?.reasoning_effort, "off"); assert.equal(data?.effort_source, "config");
		assert.equal(h.commands().find((command) => command.type === "set_thinking_level")?.level, "off");
	});
	it("keeps an existing child effort on reuse while new spawns use changed configuration", async () => {
		const h = await fixture();
		const first = await h.call("spawn_agent", { task_name: "first", message: "inspect", agent_type: "explorer", reasoning_effort: "low" });
		const target = String(first.data?.agent_id);
		await h.call("wait_agent", { ids: [target] });
		fs.writeFileSync(h.configFile, JSON.stringify({ ...h.config, profiles: { explorer: { effort: "off" } } }));
		const resumed = await h.call("send_input", { target, message: "continue" });
		assert.equal(resumed.data?.reasoning_effort, "high");
		const second = await h.call("spawn_agent", { task_name: "second", message: "inspect", agent_type: "explorer", reasoning_effort: "high" });
		assert.equal(second.data?.reasoning_effort, "off");
	});
	it("does not submit a task or leak a slot after failed effort readback", async () => {
		const h = await fixture({}, { FAKE_PI_IGNORE_EFFORT_SET: "1" });
		const { result } = await h.call("spawn_agent", { task_name: "mismatch", message: "must not run", agent_type: "explorer" });
		assert.equal(result.isError, true); assert.match(result.content[0].text, /effort mismatch/);
		assert.equal(h.commands().some((command) => command.type === "prompt"), false);
		const listed = await h.call("list_agents", {}); assert.deepEqual(listed.data?.agents, []);
	});
});
