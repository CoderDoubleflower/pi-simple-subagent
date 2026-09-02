import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSubagentCall, renderSubagentResult } from "../extensions/subagent/rendering.ts";
import type { AgentSnapshot, AgentToolDetails } from "../extensions/subagent/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	const now = Date.now();
	return {
		id: "agent_1",
		taskName: "inspect_api",
		profileName: "explorer",
		profileDescription: "Read-only exploration",
		message: "Inspect src/api",
		status: "running",
		finalOutput: "",
		stderr: "",
		model: "openai/gpt-test",
		effort: "high",
		tools: ["read", "grep"],
		cwd: "/repo",
		usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: 0.001, turns: 1 },
		activities: [
			{ id: "a1", kind: "tool", name: "grep", summary: "/authorize/ in src", status: "completed", startedAt: now - 3_000, endedAt: now - 2_000 },
			{ id: "a2", kind: "tool", name: "read", summary: "src/auth.ts", status: "running", startedAt: now - 1_000 },
		],
		startedAt: now - 5_000,
		updatedAt: now,
		display: {
			maxFinalBytes: 49_152,
			maxStderrBytes: 16_384,
			maxActivityItems: 200,
			collapsedActivityItems: 3,
			showToolActivity: true,
			showUsage: true,
			showElapsed: true,
			showExpandHint: true,
		},
		...overrides,
	};
}

function lines(value: { render(width: number): string[] }): string {
	return value.render(160).join("\n");
}

describe("Claude-style subagent rendering", () => {
	it("renders a bold agent call and compact running status with activity and expansion hint", () => {
		assert.match(lines(renderSubagentCall("spawn", { agent_type: "explorer", task_name: "inspect_api" }, theme)), /● explorer \(inspect_api\)/);
		const details: AgentToolDetails = { action: "spawn", snapshots: [snapshot()] };
		const rendered = lines(renderSubagentResult(details, false, theme));
		assert.match(rendered, /⎿\s+✻ Read\(src\/auth\.ts\)/);
		assert.match(rendered, /2 tool uses/);
		assert.match(rendered, /120 tokens/);
		assert.match(rendered, /Grep\(\/authorize\/ in src\)/);
		assert.match(rendered, /Ctrl\+O to expand details/);
	});

	it("renders expanded configuration, activity, prompt, and response sections", () => {
		const done = snapshot({
			status: "completed",
			finalOutput: "Found two issues.",
			completedAt: Date.now(),
			activities: snapshot().activities.map((item) => ({ ...item, status: "completed", endedAt: Date.now() })),
		});
		const rendered = lines(renderSubagentResult({ action: "spawn", snapshots: [done] }, true, theme));
		assert.match(rendered, /● Done/);
		assert.match(rendered, /Progress/);
		assert.match(rendered, /Configuration/);
		assert.match(rendered, /model: openai\/gpt-test/);
		assert.match(rendered, /Prompt/);
		assert.match(rendered, /Inspect src\/api/);
		assert.match(rendered, /Response/);
		assert.match(rendered, /Found two issues/);
	});

	it("renders multi-agent waits as a task tree", () => {
		const done = snapshot({ status: "completed", finalOutput: "done", completedAt: Date.now() });
		const running = snapshot({ id: "agent_2", taskName: "review_tests", profileName: "reviewer" });
		const details: AgentToolDetails = { action: "wait", snapshots: [done, running] };
		const rendered = lines(renderSubagentResult(details, false, theme));
		assert.match(rendered, /├─ explorer \(inspect_api\)/);
		assert.match(rendered, /│\s+⎿\s+● Done/);
		assert.match(rendered, /└─ reviewer \(review_tests\)/);
		assert.match(rendered, /⎿\s+✻ Read/);
	});
});
