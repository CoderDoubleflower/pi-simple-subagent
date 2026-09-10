import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/subagent/config.ts";
import { SubagentCoordinator } from "../extensions/subagent/coordinator.ts";
import { normalizeScopes, canonicalPath } from "../extensions/subagent/ownership.ts";
import type { AgentSnapshot } from "../extensions/subagent/types.ts";

type ManagerPort = ConstructorParameters<typeof SubagentCoordinator>[0];

it("joins cancelled startup cleanup before reusing the task name and write scope", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-startup-"));
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	let cleaned = false;
	const snapshots: AgentSnapshot[] = [];
	const manager: ManagerPort = {
		config: structuredClone(DEFAULT_CONFIG),
		subscribe() { return () => {}; },
		list() { return [...snapshots]; },
		async spawn(_request, _parent, signal) {
			entered();
			await new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			await new Promise((resolve) => setTimeout(resolve, 15));
			cleaned = true;
			throw new Error("startup cancelled");
		},
		async close() { snapshots.length = 0; return { previousSnapshot: { status: "not_found" } }; },
		async sendInput() { throw new Error("not used"); },
	};
	const coordinator = new SubagentCoordinator(manager, () => { assert.fail("cancelled startup must not notify"); });
	const parent = { cwd, tools: [], projectTrusted: true };
	try {
		const pending = coordinator.spawn({ taskName: "same", message: "old", writeScope: ["src/**"] }, parent);
		const failure = assert.rejects(pending, /startup cancelled/);
		await started;
		const cancellation = coordinator.cancel();
		manager.spawn = async (request) => {
			assert.equal(cleaned, true, "replacement started before old startup cleanup finished");
			const snapshot: AgentSnapshot = { id: "replacement", taskName: request.taskName, profileName: "default", status: "running", activities: [],
				message: request.message, finalOutput: "", stderr: "", tools: [], cwd, startedAt: Date.now(), updatedAt: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				display: { ...DEFAULT_CONFIG.output, showToolActivity: false },
			};
			snapshots.push(snapshot); return snapshot;
		};
		const replacement = coordinator.spawn({ taskName: "same", message: "new", writeScope: ["src/**"] }, parent);
		await cancellation; await failure; await replacement;
		assert.equal(coordinator.list().length, 1);
		assert.match(coordinator.checkParentWrite("write", "write", { path: "src/new.ts" }, cwd)!, /belongs to running subagent/);
	} finally { await coordinator.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

it("preserves filesystem roots when normalizing a trailing recursive scope", () => {
	const root = path.parse(process.cwd()).root;
	assert.deepEqual(normalizeScopes([`${root}**`], process.cwd()), [{ path: canonicalPath(root, process.cwd()), tree: true }]);
});
