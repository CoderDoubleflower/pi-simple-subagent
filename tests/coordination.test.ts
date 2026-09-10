import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SubagentCoordinator, type Completion } from "../extensions/subagent/coordinator.ts";
import { delegationGuidance, resolveProfileName } from "../extensions/subagent/guidance.ts";
import { normalizeScopes, scopesOverlap, toolWritePaths } from "../extensions/subagent/ownership.ts";
import type { AgentSnapshot, ParentDispatchDefaults, SpawnAgentRequest, SubagentConfig } from "../extensions/subagent/types.ts";

const sleep = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs: string[] = [];
const coordinators: SubagentCoordinator[] = [];
function temporary() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-coordination-")); dirs.push(dir); return dir; }
function config(): SubagentConfig {
	return {
		version: 1, defaultProfile: "default", model: "inherit", effort: "inherit", tools: "inherit", maxAgents: 4,
		rpcStartupTimeoutMs: 1000, defaultWaitTimeoutMs: 1, maxWaitTimeoutMs: 1000, killGraceMs: 100, killForceMs: 100,
		output: { maxFinalBytes: 49152, maxStderrBytes: 16384, maxActivityItems: 200, collapsedActivityItems: 3,
			showToolActivity: true, showUsage: true, showElapsed: true, showExpandHint: true },
		process: { command: "pi", extraArgs: [], env: {}, inheritEnvironment: true, excludeTools: [], approveProject: "inherit" },
		profiles: { default: {}, explorer: { description: "Read only" }, worker: { description: "Implement scoped changes" }, reviewer: {} },
	};
}
class FakeManager {
	config = config();
	private sequence = 0;
	private readonly values = new Map<string, AgentSnapshot>();
	private readonly listeners = new Set<(s: AgentSnapshot) => void>();
	failStartup = false;
	subscribe(fn: (s: AgentSnapshot) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
	list() { return [...this.values.values()].map((s) => structuredClone(s)); }
	emit(snapshot: AgentSnapshot) { this.values.set(snapshot.id, structuredClone(snapshot)); for (const listener of this.listeners) listener(structuredClone(snapshot)); }
	async spawn(request: SpawnAgentRequest, parent: ParentDispatchDefaults): Promise<AgentSnapshot> {
		const snapshot: AgentSnapshot = {
			id: `agent_${++this.sequence}`, taskName: request.taskName, profileName: request.profileName ?? "default", message: request.message,
			status: "starting", finalOutput: "", stderr: "private process log", tools: ["read"], cwd: parent.cwd,
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			activities: [{ id: "secret", kind: "tool", name: "read", summary: "PRIVATE_COMMAND", status: "running", startedAt: Date.now() }],
			startedAt: Date.now(), updatedAt: Date.now(), display: this.config.output,
		};
		this.emit(snapshot);
		await Promise.resolve();
		if (this.failStartup) { this.values.delete(snapshot.id); throw new Error("startup failed"); }
		snapshot.status = "running"; this.emit(snapshot); return snapshot;
	}
	async sendInput(id: string, message: string, _interrupt: boolean) {
		const before = structuredClone(this.values.get(id)!);
		this.emit({ ...before, status: "running", completedAt: undefined, finalOutput: "" });
		if (message === "reject") { this.emit(before); throw new Error("synthetic command rejection"); }
		return { snapshot: this.values.get(id)!, submissionId: `submission_${id}` };
	}
	complete(id: string, output = "PRIVATE_RESULT") { this.emit({ ...this.values.get(id)!, status: "completed", finalOutput: output, completedAt: Date.now() }); }
	async close(id: string) {
		const previousSnapshot = this.values.get(id);
		if (!previousSnapshot) return { previousSnapshot: { status: "not_found" as const } };
		const snapshot = { ...previousSnapshot, status: "closed" as const };
		this.emit(snapshot); this.values.delete(id); return { previousSnapshot, snapshot };
	}
}
function harness(deliver?: (results: Completion[]) => void) {
	const manager = new FakeManager();
	const delivered: Completion[] = [];
	const coordinator = new SubagentCoordinator(manager, deliver ?? ((results) => delivered.push(...results)));
	coordinators.push(coordinator);
	const parent: ParentDispatchDefaults = { cwd: temporary(), tools: ["read", "write"], projectTrusted: true };
	return { manager, coordinator, delivered, parent };
}
afterEach(async () => {
	await Promise.all(coordinators.splice(0).map((c) => c.dispose()));
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("subagent coordination", () => {
	it("normalizes empty profiles, uses configured defaults, and rejects unknown/prototype names", () => {
		const cfg = config(); cfg.defaultProfile = "explorer";
		for (const name of [undefined, "", "  "]) assert.equal(resolveProfileName(name, cfg), "explorer");
		assert.equal(resolveProfileName(" worker ", cfg), "worker");
		for (const name of ["made_up", "__proto__", "constructor"]) assert.throws(() => resolveProfileName(name, cfg), /Available profiles/);
	});
	it("advertises custom profiles and the delegation contract before the first tool call", () => {
		const cfg = config(); cfg.profiles.custom = { description: "Custom investigation" };
		const prompt = delegationGuidance(cfg);
		assert.match(prompt, /"custom": Custom investigation/); assert.match(prompt, /Do not redo the same investigation/);
		assert.equal(prompt, delegationGuidance(cfg));
	});
	it("keeps the default model-facing wait pending beyond the old default timeout", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const agent = await c.spawn({ taskName: "a", message: "PRIVATE_PROMPT" }, parent);
		let finished = false; const waiting = c.wait([agent.id]).then((value) => { finished = true; return value; });
		await sleep(30); assert.equal(finished, false); assert.equal(delivered.length, 0);
		m.complete(agent.id); const result = await waiting;
		assert.equal(result.results[0].output, "PRIVATE_RESULT"); assert.equal(result.timed_out, false);
		await sleep(); assert.equal(delivered.length, 0); assert.deepEqual((await c.wait([agent.id])).results, []);
	});
	it("automatically delivers each successful execution round only once", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "task", profileName: "" }, parent);
		assert.equal(a.profileName, "default");
		m.complete(a.id); await sleep(); m.emit(m.list()[0]); await sleep();
		assert.deepEqual(delivered.map((r) => r.round), [1]);
		await c.sendInput(a.id, "second round", false); m.complete(a.id, "second"); await sleep();
		assert.deepEqual(delivered.map((r) => r.round), [1, 2]); assert.equal(delivered[1].output, "second");
	});
	it("ignores delivered completions while waiting for other running agents", async () => {
		const { coordinator: c, manager: m, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "a" }, parent);
		const b = await c.spawn({ taskName: "b", message: "b" }, parent);
		m.complete(a.id); await sleep();
		let finished = false; const waiting = c.wait([a.id, "b", b.id]).then((r) => { finished = true; return r; });
		await sleep(); assert.equal(finished, false); m.complete(b.id);
		assert.deepEqual((await waiting).results.map((r) => r.agent_id), [b.id]);
	});
	it("keeps unrelated automatic delivery working during a reserved wait", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "a" }, parent); const b = await c.spawn({ taskName: "b", message: "b" }, parent);
		const waiting = c.wait([a.id]); m.complete(b.id); await sleep();
		assert.deepEqual(delivered.map((r) => r.agent_id), [b.id]); m.complete(a.id); await waiting; await sleep();
		assert.equal(delivered.length, 1);
	});
	it("reports unknown agents immediately without a timeout", async () => {
		const { coordinator: c } = harness(); const result = await c.wait(["missing"]);
		assert.deepEqual(result.status, { missing: "not_found" }); assert.equal(result.timed_out, false);
	});
	it("bounds explicit waits but does not cancel or release the child on timeout", async () => {
		const { coordinator: c, manager: m, parent } = harness(); m.config.maxWaitTimeoutMs = 25;
		const a = await c.spawn({ taskName: "a", message: "a", writeScope: ["owned/**"] }, parent);
		const result = await c.wait([a.id], 5000); assert.equal(result.timed_out, true);
		assert.equal(result.status[a.id], "running");
		assert.match(c.checkParentWrite("w", "write", { path: "owned/a.ts" }, parent.cwd)!, /belongs to running subagent/);
	});
	it("aborts pending waits and suppresses late completions after cancellation", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "a" }, parent); const saved = m.list()[0];
		const signal = new AbortController(); const waiting = c.wait([a.id], undefined, signal.signal);
		signal.abort(); await assert.rejects(waiting, { name: "AbortError" }); await c.cancel();
		m.emit({ ...saved, status: "completed", finalOutput: "late" }); await sleep(); assert.deepEqual(delivered, []); assert.deepEqual(c.display(), []);
	});
	it("teardown prevents pending notification timers from sending into a new session", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "a" }, parent); m.complete(a.id); await c.dispose(); await sleep();
		assert.deepEqual(delivered, []); await assert.rejects(c.wait([a.id]), { name: "AbortError" });
	});
	it("restores the delivery round after a rejected follow-up", async () => {
		const { coordinator: c, manager: m, delivered, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "a" }, parent); m.complete(a.id); await sleep();
		await assert.rejects(c.sendInput(a.id, "reject", false), /rejection/); await sleep();
		assert.equal(c.list()[0].round, 1); assert.equal(delivered.length, 1);
		await c.sendInput(a.id, "accepted", false); m.complete(a.id); await sleep(); assert.equal(delivered[1].round, 2);
	});
	it("never exposes private bodies through list or display snapshots", async () => {
		const { coordinator: c, manager: m, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "PRIVATE_PROMPT" }, parent); m.complete(a.id);
		const publicState = JSON.stringify([c.list(), c.display()]);
		for (const secret of ["PRIVATE_PROMPT", "PRIVATE_RESULT", "PRIVATE_COMMAND", "private process log"]) assert.ok(!publicState.includes(secret));
	});
	it("retains a failed automatic delivery for wait without spinning", async () => {
		let attempts = 0; const { coordinator: c, manager: m, parent } = harness(() => { attempts++; throw new Error("send failed"); });
		const a = await c.spawn({ taskName: "a", message: "a" }, parent); m.complete(a.id); await sleep(30);
		assert.equal(attempts, 1); assert.equal((await c.wait([a.id])).results.length, 1);
	});
	it("requires worker scopes and reserves them before asynchronous startup", async () => {
		const { coordinator: c, parent } = harness();
		await assert.rejects(c.spawn({ taskName: "missing", profileName: "worker", message: "work" }, parent), /requires a non-empty write_scope/);
		const first = c.spawn({ taskName: "first", profileName: "worker", message: "work", writeScope: ["src/**"] }, parent);
		const second = c.spawn({ taskName: "second", message: "work", writeScope: ["src/file.ts"] }, parent);
		await assert.rejects(second, /scope/i); await first;
	});
	it("blocks owned writes including patch rename destinations and releases scopes after completion", async () => {
		const { coordinator: c, manager: m, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "work", writeScope: ["src/auth/**"] }, parent);
		assert.match(c.checkParentWrite("one", "edit", { path: "src/auth/a.ts" }, parent.cwd)!, /belongs to running subagent/);
		assert.match(c.checkParentWrite("two", "apply_patch", { patch: "*** Update File: elsewhere.ts\n*** Move to: src/auth/new.ts\n" }, parent.cwd)!, /belongs/);
		assert.equal(c.checkParentWrite("three", "write", { path: "src/author.ts" }, parent.cwd), undefined); c.finishParentWrite("three");
		assert.equal(c.checkParentWrite("read", "read", { path: "src/auth/a.ts" }, parent.cwd), undefined);
		m.complete(a.id); assert.equal(c.checkParentWrite("four", "write", { path: "src/auth/a.ts" }, parent.cwd), undefined);
	});
	it("does not assign a child scope overlapping an in-flight parent write", async () => {
		const { coordinator: c, parent } = harness();
		assert.equal(c.checkParentWrite("parent", "write", { path: "src/file.ts" }, parent.cwd), undefined);
		await assert.rejects(c.spawn({ taskName: "a", message: "work", writeScope: ["src/**"] }, parent), /parent file-writing tool/);
		c.finishParentWrite("parent"); await c.spawn({ taskName: "a", message: "work", writeScope: ["src/**"] }, parent);
	});
	it("releases reservations and removes private state after a startup failure", async () => {
		const { coordinator: c, manager: m, parent } = harness(); m.failStartup = true;
		await assert.rejects(c.spawn({ taskName: "a", message: "work", writeScope: ["src/**"] }, parent), /startup failed/);
		assert.deepEqual(c.display(), []); m.failStartup = false;
		await c.spawn({ taskName: "a", message: "work", writeScope: ["src/**"] }, parent);
	});
	it("reacquires original scopes before resuming a completed agent", async () => {
		const { coordinator: c, manager: m, parent } = harness();
		const a = await c.spawn({ taskName: "a", message: "work", writeScope: ["src/**"] }, parent); m.complete(a.id);
		await c.spawn({ taskName: "b", message: "work", writeScope: ["src/**"] }, parent);
		await assert.rejects(c.sendInput(a.id, "next", false), /belongs to running subagent/);
	});
	it("canonicalizes symlinks and does not confuse sibling prefixes", () => {
		const root = temporary(); fs.mkdirSync(path.join(root, "real")); fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"), "dir");
		const [owned] = normalizeScopes(["real/**"], root); const [alias] = normalizeScopes(["alias/new.ts"], root);
		assert.equal(scopesOverlap(owned, alias), true);
		assert.equal(scopesOverlap(owned, normalizeScopes(["reality.ts"], root)[0]), false);
		assert.throws(() => normalizeScopes(["src/*.ts"], root), /arbitrary globs/);
		assert.deepEqual(toolWritePaths("apply_patch", { input: "*** Delete File: old.ts\n*** Add File: new.ts\n" }), ["old.ts", "new.ts"]);
	});
});
