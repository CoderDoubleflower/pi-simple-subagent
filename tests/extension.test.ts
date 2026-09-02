import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import simpleSubagentExtension from "../extensions/subagents.ts";

interface RegisteredTool {
	name: string;
}

const originalChildFlag = process.env.PI_SIMPLE_SUBAGENT_CHILD;

afterEach(() => {
	if (originalChildFlag === undefined) delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
	else process.env.PI_SIMPLE_SUBAGENT_CHILD = originalChildFlag;
});

function registrationHarness() {
	const tools: RegisteredTool[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string) {
			events.push(name);
		},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
	};
	return { pi, tools, commands, events };
}

describe("extension entry point", () => {
	it("registers the Codex-style tools and exactly one unified configuration command", () => {
		delete process.env.PI_SIMPLE_SUBAGENT_CHILD;
		const harness = registrationHarness();
		simpleSubagentExtension(harness.pi as never);
		assert.deepEqual(
			harness.tools.map((tool) => tool.name),
			["spawn_agent", "send_input", "wait_agent", "close_agent", "list_agents"],
		);
		assert.deepEqual(harness.commands, ["subagent-config"]);
		assert.deepEqual(harness.events, ["session_start", "session_shutdown"]);
	});

	it("does not register orchestration tools inside child Pi processes", () => {
		process.env.PI_SIMPLE_SUBAGENT_CHILD = "1";
		const harness = registrationHarness();
		simpleSubagentExtension(harness.pi as never);
		assert.deepEqual(harness.tools, []);
		assert.deepEqual(harness.commands, []);
		assert.deepEqual(harness.events, []);
	});
});
