import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonLineDecoder } from "../extensions/subagent/jsonl.ts";

describe("JsonLineDecoder", () => {
	it("preserves U+2028 and U+2029 inside JSON strings", () => {
		const decoder = new JsonLineDecoder();
		const line = JSON.stringify({ text: "a\u2028b\u2029c" });
		assert.deepEqual(decoder.push(`${line}\n`), [line]);
	});

	it("handles a split UTF-8 code point", () => {
		const decoder = new JsonLineDecoder();
		const bytes = Buffer.from(`${JSON.stringify({ text: "中文" })}\n`);
		const split = bytes.indexOf(Buffer.from("中")) + 1;
		assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
		const lines = decoder.push(bytes.subarray(split));
		assert.deepEqual(JSON.parse(lines[0]), { text: "中文" });
	});

	it("returns the final unterminated line from end", () => {
		const decoder = new JsonLineDecoder();
		assert.deepEqual(decoder.push('{"ok":'), []);
		assert.deepEqual(decoder.end("true}"), ['{"ok":true}']);
	});
});
