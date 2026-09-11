import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../extensions/subagent/config.ts";
import { selectDispatchModel } from "../extensions/subagent/model-selection.ts";
import { verifyRpcModel, type RpcModel } from "../extensions/subagent/rpc-model.ts";
import { AgentManager } from "../extensions/subagent/agent-manager.ts";

const managers: AgentManager[] = [], dirs: string[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function mockRpc(models: RpcModel[], initial: RpcModel, ignoreSet = false) {
	let model = initial; const commands: Record<string, unknown>[] = [];
	const request = async (command: Record<string, unknown>): Promise<unknown> => {
		commands.push(command);
		switch (command.type) {
			case "get_available_models": return { models };
			case "set_model": if (!ignoreSet) model = { provider: String(command.provider), id: String(command.modelId) }; return model;
			case "get_state": return { model };
			case "set_thinking_level": return undefined;
			default: throw new Error("Unexpected RPC");
		}
	};
	return { request, commands };
}
function fixture(env: Record<string, string> = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-model-")); dirs.push(cwd);
	const commandFile = path.join(cwd, "commands.jsonl"), pidFile = path.join(cwd, "pid");
	const config = normalizeConfig({ ...DEFAULT_CONFIG, rpcStartupTimeoutMs: 2000, killGraceMs: 100, killForceMs: 1000,
		process: { ...DEFAULT_CONFIG.process, command: process.execPath, extraArgs: [fileURLToPath(new URL("./fake-pi.mjs", import.meta.url))],
			env: { FAKE_PI_COMMANDS_FILE: commandFile, FAKE_PI_PID_FILE: pidFile, ...env } } });
	const manager = new AgentManager(config); managers.push(manager);
	return { manager, cwd, pidFile, parent: { cwd, model: "openai/child", effort: "medium" as const, tools: ["read"], projectTrusted: true },
		commands: () => fs.readFileSync(commandFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) };
}
describe("configured models and actual RPC verification", () => {
	it("protects explicit root settings from model-authored overrides", () => {
		const config = normalizeConfig({ model: "p/child" });
		assert.deepEqual(selectDispatchModel(config, "", "p/parent", "p/parent"), { model: "p/child", source: "config", ignoredOverride: "p/parent" });
	});
	it("prefers profile configuration and inherits only when configuration permits it", () => {
		const config = normalizeConfig({ model: "p/root", profiles: { explorer: { model: "p/profile" } } });
		assert.equal(selectDispatchModel(config, "explorer", "p/override", "p/parent").model, "p/profile");
		const inherited = normalizeConfig({});
		assert.equal(selectDispatchModel(inherited, undefined, " inherit ", "p/parent").source, "parent");
		assert.equal(selectDispatchModel(inherited, undefined, "p/task", "p/parent").source, "request");
	});
	it("sets the exact provider/model and thinking level before reading back actual state", async () => {
		const rpc = mockRpc([{ provider: "custom", id: "org/model" }], { provider: "parent", id: "large" });
		assert.equal(await verifyRpcModel(rpc.request, "custom/org/model", "high"), "custom/org/model");
		assert.deepEqual(rpc.commands.map((c) => c.type), ["get_available_models", "set_model", "set_thinking_level", "get_state"]);
		assert.deepEqual(rpc.commands[1], { type: "set_model", provider: "custom", modelId: "org/model" });
	});
	it("supports an exact bare model ID but rejects ambiguous IDs", async () => {
		const rpc = mockRpc([{ provider: "p", id: "model" }], { provider: "p", id: "other" });
		assert.equal(await verifyRpcModel(rpc.request, "model"), "p/model");
		const ambiguous = mockRpc([{ provider: "a", id: "model" }, { provider: "b", id: "model" }], { provider: "a", id: "model" });
		await assert.rejects(verifyRpcModel(ambiguous.request, "model"), /Ambiguous/);
	});
	it("does not silently fall back to a parent model when configuration is missing", async () => {
		const rpc = mockRpc([{ provider: "p", id: "parent" }], { provider: "p", id: "parent" });
		await assert.rejects(verifyRpcModel(rpc.request, "p/missing"), /unavailable/);
		assert.equal(rpc.commands.some((c) => c.type === "set_model"), false);
	});
	it("rejects mismatching or absent child state", async () => {
		const rpc = mockRpc([{ provider: "p", id: "child" }], { provider: "p", id: "parent" }, true);
		await assert.rejects(verifyRpcModel(rpc.request, "p/child"), /model mismatch/);
		await assert.rejects(verifyRpcModel(async () => ({})), /did not report/);
	});
	it("corrects a real RPC child initialized with another model before sending the prompt", async () => {
		const h = fixture({ FAKE_PI_START_MODEL: "openai/parent" });
		const s = await h.manager.spawn({ taskName: "verified", message: "first" }, h.parent);
		assert.equal(s.model, "openai/child");
		const commands = h.commands();
		assert.ok(commands.findIndex((c) => c.type === "set_model") < commands.findIndex((c) => c.type === "prompt"));
		await h.manager.wait([s.id], 2000);
		await h.manager.sendInput(s.id, "second", false);
		await h.manager.wait([s.id], 2000);
		// Every submitted round verifies both the model and effective reasoning effort.
		assert.equal(h.commands().filter((c) => c.type === "get_state").length, 4);
		assert.equal(h.manager.list()[0].effort, "medium");
	});
	it("never submits a task when RPC model verification fails", async () => {
		const h = fixture({ FAKE_PI_START_MODEL: "openai/parent", FAKE_PI_IGNORE_MODEL_SET: "1" });
		await assert.rejects(h.manager.spawn({ taskName: "mismatch", message: "must not run" }, h.parent), /model mismatch/);
		assert.equal(h.commands().some((c) => c.type === "prompt"), false); assert.equal(h.manager.list().length, 0);
	});
	it("escalates to SIGKILL if SIGTERM was sent but the child did not exit", { skip: process.platform === "win32" }, async () => {
		const h = fixture({ FAKE_PI_IGNORE_TERM: "1" });
		const s = await h.manager.spawn({ taskName: "stubborn", message: "[delay=1000]" }, h.parent);
		const pid = Number(fs.readFileSync(h.pidFile, "utf8"));
		await h.manager.close(s.id);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
});
