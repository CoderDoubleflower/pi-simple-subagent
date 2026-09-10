import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HIDDEN_TOOL_ROW, renderSubagentCall, renderSubagentResult } from "../extensions/subagent/rendering.ts";
import type { AgentToolDetails } from "../extensions/subagent/types.ts";

const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
describe("hidden subagent transcript rendering", () => {
	for (const action of ["spawn", "send", "wait", "close", "list"] as const) {
		it(`never displays ${action} arguments or results, including expanded and partial legacy details`, () => {
			const details = { action, timedOut: true, message: "PRIVATE_ERROR", snapshots: [{
				message: "PRIVATE_PROMPT", finalOutput: "PRIVATE_RESPONSE", stderr: "PRIVATE_STDERR",
			}] } as AgentToolDetails;
			assert.deepEqual(renderSubagentCall(action, { message: "PRIVATE_PROMPT" }, theme).render(80), []);
			for (const expanded of [false, true]) for (const partial of [false, true]) {
				assert.deepEqual(renderSubagentResult(details, expanded, theme, partial).render(80), []);
			}
			assert.deepEqual(HIDDEN_TOOL_ROW.render(1), []);
		});
	}
});
