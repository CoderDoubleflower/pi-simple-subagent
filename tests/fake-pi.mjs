#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const modeIndex = argv.lastIndexOf("--mode");
const required = modeIndex >= 0 && argv[modeIndex + 1] === "rpc" && argv.includes("--no-session") && argv.includes("--append-system-prompt") && argv.includes("--exclude-tools");
const approval = process.env.FAKE_PI_REQUIRE_APPROVAL;
const approvalMatches = approval === "approve" ? argv.includes("--approve") && !argv.includes("--no-approve") : approval === "no-approve" ? argv.includes("--no-approve") && !argv.includes("--approve") : true;
if (!required || !approvalMatches) { process.stderr.write(`fake-pi: unexpected arguments: ${argv.join(" ")}\n`); process.exit(64); }
const failOnceFile = process.env.FAKE_PI_FAIL_ONCE_FILE;
if (failOnceFile && !fs.existsSync(failOnceFile)) { fs.writeFileSync(failOnceFile, "failed\n"); process.stderr.write("fake-pi: synthetic first-start failure\n"); process.exit(65); }
if (process.env.FAKE_PI_ARGS_FILE) fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(argv));
if (process.env.FAKE_PI_IGNORE_TERM) process.on("SIGTERM", () => {});
if (process.env.FAKE_PI_PID_FILE) fs.writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
const modelIndex = argv.lastIndexOf("--model");
function parseModel(value) {
	const slash = value.indexOf("/");
	return slash < 0 ? { provider: "openai", id: value } : { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
const requested = parseModel(modelIndex >= 0 ? argv[modelIndex + 1] : "openai/test");
const models = process.env.FAKE_PI_MODELS ? JSON.parse(process.env.FAKE_PI_MODELS) : [requested];
let model = process.env.FAKE_PI_START_MODEL ? parseModel(process.env.FAKE_PI_START_MODEL) : requested;
let thinkingLevel = "medium";
let turn = 0, timestamp = 0, activeTimer = null, pendingUi = null, active = false;
const queue = [], messages = [];
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function respond(command, success = true, error, data) { emit({ id: command.id, type: "response", command: command.type, success, ...(error ? { error } : {}), ...(data !== undefined ? { data } : {}) }); }
function parseDelay(message) { const match = /\[delay=(\d+)\]/.exec(message); return match ? Number.parseInt(match[1], 10) : 25; }
function emitAssistantEnd({ text, stopReason = "stop", errorMessage, currentTurn }) {
	const message = { role: "assistant", content: [{ type: "text", text }], timestamp: ++timestamp, provider: model.provider, model: model.id, stopReason, errorMessage,
		usage: { input: 10 * currentTurn, output: 5 * currentTurn, cacheRead: currentTurn, cacheWrite: 0, cost: { total: 0.001 * currentTurn } } };
	messages.push(message); emit({ type: "message_end", message }); emit({ type: "agent_end", messages: [] });
}
function settle() {
	active = false;
	if (queue.length) runTurn(queue.shift());
	else emit({ type: "agent_settled" });
}
function runTurn(text) {
	active = true; turn++; const currentTurn = turn;
	emit({ type: "agent_start" });
	const userMessage = { role: "user", content: [{ type: "text", text }], timestamp: ++timestamp };
	messages.push(userMessage); emit({ type: "message_end", message: userMessage });
	if (text.includes("[invalid-json]")) process.stdout.write("this is not json\n");
	if (text.includes("[stderr-long]")) process.stderr.write("错".repeat(2000));
	if (text.includes("[exit]")) { setTimeout(() => process.exit(70), 10); return; }
	if (text.includes("[notify]")) emit({ type: "extension_ui_request", id: `notify-${currentTurn}`, method: "notify", message: "progress" });
	if (text.includes("[ui]")) { const id = `ui-${currentTurn}`; pendingUi = { id, currentTurn }; emit({ type: "extension_ui_request", id, method: "input", title: "Synthetic question" }); return; }
	emit({ type: "tool_execution_start", toolCallId: `tool-${currentTurn}`, toolName: "read", args: { path: `src/turn-${currentTurn}.ts` } });
	activeTimer = setTimeout(() => {
		activeTimer = null;
		emit({ type: "tool_execution_end", toolCallId: `tool-${currentTurn}`, toolName: "read", isError: false });
		if (text.includes("[retry]")) {
			emitAssistantEnd({ text: "first attempt failed", stopReason: "error", errorMessage: "transient failure", currentTurn });
			emit({ type: "agent_start" });
			emit({ type: "tool_execution_start", toolCallId: `tool-${currentTurn}-retry`, toolName: "grep", args: { pattern: "retry", path: "src" } });
			activeTimer = setTimeout(() => {
				activeTimer = null;
				emit({ type: "tool_execution_end", toolCallId: `tool-${currentTurn}-retry`, toolName: "grep", isError: false });
				emitAssistantEnd({ text: `retry success: ${text}`, currentTurn }); settle();
			}, 20); return;
		}
		const long = /\[long=(\d+)\]/.exec(text);
		const output = text === "show_argv" ? `argv:${argv.join("|")}` : long ? "界".repeat(Number.parseInt(long[1], 10)) : `turn ${currentTurn}: ${text.replace(/\s+/g, " ").trim()}`;
		emitAssistantEnd({ text: output, stopReason: text.includes("[error]") ? "error" : "stop", errorMessage: text.includes("[error]") ? "synthetic failure" : undefined, currentTurn }); settle();
	}, parseDelay(text));
}
rl.on("line", (line) => {
	if (!line.trim()) return;
	let command; try { command = JSON.parse(line); } catch { return; }
	if (process.env.FAKE_PI_COMMANDS_FILE) fs.appendFileSync(process.env.FAKE_PI_COMMANDS_FILE, `${JSON.stringify(command)}\n`);
	switch (command.type) {
		case "get_available_models": respond(command, true, undefined, { models }); break;
		case "set_model":
			if (!models.some((m) => m.provider === command.provider && m.id === command.modelId)) respond(command, false, "Unknown model");
			else { if (!process.env.FAKE_PI_IGNORE_MODEL_SET) model = { provider: command.provider, id: command.modelId }; respond(command, true, undefined, model); } break;
		case "set_thinking_level": thinkingLevel = command.level; respond(command); break;
		case "get_state": respond(command, true, undefined, { model, thinkingLevel, isStreaming: active }); break;
		case "get_messages": respond(command, true, undefined, { messages }); break;
		case "prompt": case "follow_up": case "steer": {
			const text = String(command.message ?? "");
			if (text.includes("[reject]")) { respond(command, false, "synthetic command rejection"); break; }
			respond(command);
			if (active) { if (command.type === "steer") queue.unshift(text); else queue.push(text); }
			else runTurn(text);
			break;
		}
		case "extension_ui_response":
			if (pendingUi && command.id === pendingUi.id && command.cancelled === true) { const { currentTurn } = pendingUi; pendingUi = null; emitAssistantEnd({ text: "extension UI was cancelled", currentTurn }); settle(); } break;
		case "abort":
			if (activeTimer) clearTimeout(activeTimer); activeTimer = null; pendingUi = null; queue.length = 0; active = false;
			respond(command); emit({ type: "agent_settled" }); break;
		default: respond(command, false, `Unsupported fake command: ${command.type}`);
	}
});
rl.on("close", () => { if (activeTimer) clearTimeout(activeTimer); process.exit(0); });
