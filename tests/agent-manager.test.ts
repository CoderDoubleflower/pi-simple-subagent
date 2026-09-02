import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, before, describe, it } from "node:test";
import { AgentManager } from "../extensions/subagent/agent-manager.ts";
import { byteTruncate } from "../extensions/subagent/agent-process.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../extensions/subagent/config.ts";
import type { AgentSnapshot, ParentDispatchDefaults, SubagentConfig, WaitResult } from "../extensions/subagent/types.ts";

const fakePi = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
const cwd = path.dirname(fakePi);
const managers: AgentManager[] = [];
const tempDirs: string[] = [];

before(() => {
	fs.chmodSync(fakePi, 0o755);
});

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((instance) => instance.shutdown()));
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagent-agent-test-"));
	tempDirs.push(dir);
	return dir;
}

function manager(maxAgents = 2, overrides: Partial<SubagentConfig> = {}): AgentManager {
	const config = normalizeConfig({
		...DEFAULT_CONFIG,
		...overrides,
		maxAgents,
		rpcStartupTimeoutMs: overrides.rpcStartupTimeoutMs ?? 2_000,
		defaultWaitTimeoutMs: overrides.defaultWaitTimeoutMs ?? 1_000,
		maxWaitTimeoutMs: overrides.maxWaitTimeoutMs ?? 2_000,
		killGraceMs: overrides.killGraceMs ?? 120,
		killForceMs: overrides.killForceMs ?? 120,
		output: { ...DEFAULT_CONFIG.output, ...(overrides.output ?? {}) },
		process: {
			...DEFAULT_CONFIG.process,
			command: fakePi,
			extraArgs: [],
			...(overrides.process ?? {}),
		},
		profiles: { ...DEFAULT_CONFIG.profiles, ...(overrides.profiles ?? {}) },
	});
	const instance = new AgentManager(config);
	managers.push(instance);
	return instance;
}

const parent: ParentDispatchDefaults = {
	cwd,
	model: "openai/test",
	effort: "medium",
	tools: ["read", "grep"],
	projectTrusted: true,
};

function snapshot(result: WaitResult, target: string): AgentSnapshot {
	const value = result.status[target];
	if (!value || !("id" in value)) throw new Error(`Expected ${target} to resolve to an agent snapshot.`);
	return value;
}

function listed(agents: AgentManager, target: string): AgentSnapshot {
	const value = agents.list().find((item) => item.id === target || item.taskName === target);
	if (!value) throw new Error(`Expected ${target} in the manager list.`);
	return value;
}

describe("AgentManager", () => {
	it("spawns, waits, captures activity and usage, reuses context, and closes", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "inspect_api", message: "first" }, parent);
		assert.equal(started.status, "running");

		const first = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.equal(first.status, "completed");
		assert.equal(first.finalOutput, "turn 1: first");
		assert.equal(first.activities.length, 1);
		assert.equal(first.activities[0].name, "read");
		assert.equal(first.activities[0].status, "completed");
		assert.deepEqual(first.usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.001, turns: 1 });

		const sent = await agents.sendInput("inspect_api", "second", false);
		assert.match(sent.submissionId, /^submission_/);
		assert.equal(sent.snapshot.status, "running");
		const second = snapshot(await agents.wait(["inspect_api"], 1_000), "inspect_api");
		assert.equal(second.finalOutput, "turn 2: second");
		assert.equal(second.usage.input, 30);
		assert.equal(second.usage.output, 15);
		assert.equal(second.usage.turns, 2);

		const before = Date.now();
		const closed = await agents.close(started.id);
		assert.ok("id" in closed.previousSnapshot);
		assert.equal(closed.previousSnapshot.status, "completed");
		assert.equal(closed.snapshot?.status, "closed");
		assert.ok(Date.now() - before < 1_000, "a cooperative child should close without waiting for both kill timers");
	});

	it("preserves a completed result when a follow-up prompt is rejected", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "preserve", message: "original" }, parent);
		const original = snapshot(await agents.wait([started.id], 1_000), started.id);
		await assert.rejects(() => agents.sendInput(started.id, "[reject] replacement", false), /synthetic command rejection/);
		const restored = listed(agents, started.id);
		assert.equal(restored.status, "completed");
		assert.equal(restored.finalOutput, original.finalOutput);
		assert.equal(restored.completedAt, original.completedAt);
	});

	it("enforces capacity until close and returns not_found for an unknown close", async () => {
		const agents = manager(1);
		const first = await agents.spawn({ taskName: "one", message: "one" }, parent);
		await assert.rejects(() => agents.spawn({ taskName: "two", message: "two" }, parent), /limit/);
		await agents.close(first.id);
		const second = await agents.spawn({ taskName: "two", message: "two" }, parent);
		assert.equal(second.taskName, "two");
		await agents.close(second.id);
		const reused = await agents.spawn({ taskName: "one", message: "reused after close" }, parent);
		assert.equal(reused.taskName, "one");
		assert.deepEqual((await agents.close("missing")).previousSnapshot, { status: "not_found" });
	});

	it("rejects duplicate or malformed task names", async () => {
		const agents = manager();
		await agents.spawn({ taskName: "same_name", message: "first" }, parent);
		await assert.rejects(() => agents.spawn({ taskName: "same_name", message: "second" }, parent), /already exists/);
		await assert.rejects(() => agents.spawn({ taskName: "Bad name!", message: "third" }, parent), /task_name/);
	});

	it("reports unknown waits without treating them as timeouts", async () => {
		const agents = manager();
		const result = await agents.wait(["missing"], 10);
		assert.deepEqual(result.status.missing, { status: "not_found" });
		assert.equal(result.timedOut, false);
	});

	it("passes inherited model, effort, tools, and trusted-project approval", async () => {
		const agents = manager(2, {
			process: { ...DEFAULT_CONFIG.process, command: fakePi, env: { FAKE_PI_REQUIRE_APPROVAL: "approve" } },
		});
		const started = await agents.spawn({ taskName: "inspect_args", message: "show_argv" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.match(result.finalOutput, /--mode\|rpc/);
		assert.match(result.finalOutput, /--no-session/);
		assert.match(result.finalOutput, /--model\|openai\/test/);
		assert.match(result.finalOutput, /--thinking\|medium/);
		assert.match(result.finalOutput, /--tools\|read,grep/);
		assert.match(result.finalOutput, /--exclude-tools\|spawn_agent,send_input,wait_agent,close_agent,list_agents,subagent/);
		assert.match(result.finalOutput, /--approve/);
	});

	it("passes --no-approve when inherited project trust is false", async () => {
		const agents = manager(2, {
			process: { ...DEFAULT_CONFIG.process, command: fakePi, env: { FAKE_PI_REQUIRE_APPROVAL: "no-approve" } },
		});
		const started = await agents.spawn(
			{ taskName: "untrusted", message: "show_argv" },
			{ ...parent, projectTrusted: false },
		);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.match(result.finalOutput, /--no-approve/);
	});

	it("applies profile settings and explicit spawn overrides in the documented order", async () => {
		const argsFile = path.join(tempDir(), "argv.json");
		const agents = manager(2, {
			model: "openai/root",
			effort: "low",
			tools: ["read"],
			process: {
				...DEFAULT_CONFIG.process,
				command: fakePi,
				extraArgs: ["--mode", "text", "--no-context-files"],
				env: { FAKE_PI_ARGS_FILE: argsFile },
				approveProject: "always",
			},
			profiles: {
				...DEFAULT_CONFIG.profiles,
				custom: {
					description: "custom profile",
					systemPrompt: "custom instructions",
					model: "openai/profile",
					effort: "high",
					tools: ["ls"],
					extraArgs: ["--offline"],
				},
			},
		});
		const started = await agents.spawn(
			{
				taskName: "override_order",
				message: "show_argv",
				profileName: "custom",
				model: "openai/request",
				effort: "xhigh",
				tools: ["grep", "find"],
			},
			parent,
		);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.equal(result.profileDescription, "custom profile");
		assert.equal(result.model, "openai/request");
		assert.equal(result.effort, "xhigh");
		assert.deepEqual(result.tools, ["grep", "find"]);
		const argv = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
		assert.ok(argv.includes("--no-context-files"));
		assert.ok(argv.includes("--offline"));
		assert.equal(argv[argv.lastIndexOf("--mode") + 1], "rpc", "fixed RPC mode must override conflicting extra args");
		assert.equal(argv[argv.indexOf("--model") + 1], "openai/request");
		assert.equal(argv[argv.indexOf("--thinking") + 1], "xhigh");
		assert.equal(argv[argv.indexOf("--tools") + 1], "grep,find");
	});

	it("removes process-level excluded tools from the resolved child allowlist", async () => {
		const agents = manager(2, {
			process: {
				...DEFAULT_CONFIG.process,
				command: fakePi,
				excludeTools: [...DEFAULT_CONFIG.process.excludeTools, "grep"],
			},
		});
		const started = await agents.spawn({ taskName: "excluded_tool", message: "show_argv", tools: ["read", "grep"] }, parent);
		assert.deepEqual(started.tools, ["read"]);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.match(result.finalOutput, /--tools\|read(?:\||$)/);
		assert.ok(!result.finalOutput.includes("--tools|read,grep"));
	});

	it("uses --no-tools for an explicit empty child tool set", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "no_tools", message: "show_argv", tools: "none" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.match(result.finalOutput, /--no-tools/);
	});

	it("clears transient retry errors and records both attempts", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "retry", message: "[retry] retry_success" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.equal(result.status, "completed");
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "retry success: [retry] retry_success");
		assert.deepEqual(result.activities.map((item) => item.name), ["read", "grep"]);
		assert.ok(result.activities.every((item) => item.status === "completed"));
	});

	it("reports a settled model error as errored", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "failure", message: "[error] terminal_error" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.equal(result.status, "errored");
		assert.match(result.error ?? "", /synthetic failure/);
	});

	it("reports an unexpected child-process exit as errored", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "process_exit", message: "[exit]" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.equal(result.status, "errored");
		assert.match(result.error ?? "", /Process exited/);
	});

	it("times out without closing a live agent and supports AbortSignal", async () => {
		const agents = manager();
		const started = await agents.spawn({ taskName: "long", message: "[delay=500] long" }, parent);
		const timeout = await agents.wait([started.id], 25);
		assert.equal(timeout.timedOut, true);
		assert.equal(snapshot(timeout, started.id).status, "running");

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(() => agents.wait([started.id], 1_000, controller.signal), /aborted/);
		assert.equal(listed(agents, started.id).status, "running");
	});

	it("auto-cancels blocking extension UI but ignores fire-and-forget notifications", async () => {
		const agents = manager();
		const blocking = await agents.spawn({ taskName: "ui", message: "[ui] ui_request" }, parent);
		const blockingResult = snapshot(await agents.wait([blocking.id], 1_000), blocking.id);
		assert.equal(blockingResult.status, "completed");
		assert.match(blockingResult.stderr, /auto-cancelled/);

		const notify = await agents.spawn({ taskName: "notify", message: "[notify] continue" }, parent);
		const notifyResult = snapshot(await agents.wait([notify.id], 1_000), notify.id);
		assert.equal(notifyResult.status, "completed");
		assert.ok(!notifyResult.stderr.includes("extension_ui:notify"));
	});

	it("records malformed RPC stdout and bounds stderr", async () => {
		const agents = manager(2, { output: { ...DEFAULT_CONFIG.output, maxStderrBytes: 1_024 } });
		const started = await agents.spawn({ taskName: "diagnostics", message: "[invalid-json] [stderr-long]" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.match(result.stderr, /stderr truncated|ignored non-JSON/);
		assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1_024);
		assert.ok(!result.stderr.includes("�"));
	});

	it("removes a failed start from the registry so it cannot leak capacity", async () => {
		const marker = path.join(tempDir(), "fail-once");
		const agents = manager(1, {
			process: {
				...DEFAULT_CONFIG.process,
				command: fakePi,
				env: { FAKE_PI_FAIL_ONCE_FILE: marker },
			},
		});
		await assert.rejects(() => agents.spawn({ taskName: "first_start", message: "first" }, parent), /exited|stdin|closed/i);
		assert.equal(agents.list().length, 0);
		const recovered = await agents.spawn({ taskName: "second_start", message: "second" }, parent);
		assert.equal(recovered.status, "running");
	});

	it("cleans up an already-aborted start without leaking capacity", async () => {
		const agents = manager(1);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(() => agents.spawn({ taskName: "aborted_start", message: "first" }, parent, controller.signal), /aborted/);
		assert.equal(agents.list().length, 0);
		const recovered = await agents.spawn({ taskName: "after_abort", message: "second" }, parent);
		assert.equal(recovered.status, "running");
	});

	it("truncates UTF-8 output at byte boundaries including the marker", async () => {
		const agents = manager(2, { output: { ...DEFAULT_CONFIG.output, maxFinalBytes: 1_024 } });
		const started = await agents.spawn({ taskName: "truncate", message: "[long=500]" }, parent);
		const result = snapshot(await agents.wait([started.id], 1_000), started.id);
		assert.ok(Buffer.byteLength(result.finalOutput, "utf8") <= 1_024);
		assert.match(result.finalOutput, /Output truncated/);
		assert.ok(!result.finalOutput.includes("�"));

		const direct = byteTruncate("界".repeat(10), 11, "...");
		assert.ok(Buffer.byteLength(direct, "utf8") <= 11);
		assert.ok(!direct.includes("�"));
	});
});
