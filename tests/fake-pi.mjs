#!/usr/bin/env node

import fs from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const modeIndex = argv.lastIndexOf("--mode");
const excludeIndex = argv.indexOf("--exclude-tools");
const requiredArgsArePresent =
	modeIndex >= 0 &&
	argv[modeIndex + 1] === "rpc" &&
	argv.includes("--no-session") &&
	argv.includes("--append-system-prompt") &&
	excludeIndex >= 0;
const approvalRequirement = process.env.FAKE_PI_REQUIRE_APPROVAL;
const approvalMatches =
	approvalRequirement === "approve"
		? argv.includes("--approve") && !argv.includes("--no-approve")
		: approvalRequirement === "no-approve"
			? argv.includes("--no-approve") && !argv.includes("--approve")
			: true;

if (!requiredArgsArePresent || !approvalMatches) {
	process.stderr.write(`fake-pi: unexpected arguments: ${argv.join(" ")}\n`);
	process.exit(64);
}

const failOnceFile = process.env.FAKE_PI_FAIL_ONCE_FILE;
if (failOnceFile && !fs.existsSync(failOnceFile)) {
	fs.writeFileSync(failOnceFile, "failed\n");
	process.stderr.write("fake-pi: synthetic first-start failure\n");
	process.exit(65);
}
if (process.env.FAKE_PI_ARGS_FILE) fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(argv));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
let activeTimer = null;
let pendingUi = null;

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function respond(command, success = true, error) {
	if (success) emit({ id: command.id, type: "response", command: command.type, success: true });
	else emit({ id: command.id, type: "response", command: command.type, success: false, error });
}
function parseDelay(message) {
	const match = /\[delay=(\d+)\]/.exec(message);
	return match ? Number.parseInt(match[1], 10) : 25;
}
function emitAssistantEnd({ text, stopReason = "stop", errorMessage, currentTurn }) {
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			errorMessage,
			usage: {
				input: 10 * currentTurn,
				output: 5 * currentTurn,
				cacheRead: currentTurn,
				cacheWrite: 0,
				cost: { total: 0.001 * currentTurn },
			},
		},
	});
	emit({ type: "agent_end", messages: [] });
}

function runTurn(message) {
	turn += 1;
	const currentTurn = turn;
	emit({ type: "agent_start" });

	if (message.includes("[invalid-json]")) process.stdout.write("this is not json\n");
	if (message.includes("[stderr-long]")) process.stderr.write("错".repeat(2_000));
	if (message.includes("[exit]")) {
		setTimeout(() => process.exit(70), 10);
		return;
	}
	if (message.includes("[notify]")) {
		emit({ type: "extension_ui_request", id: `notify-${currentTurn}`, method: "notify", message: "progress" });
	}
	if (message.includes("[ui]")) {
		const id = `ui-${currentTurn}`;
		pendingUi = { id, currentTurn };
		emit({ type: "extension_ui_request", id, method: "input", title: "Synthetic question" });
		return;
	}

	emit({
		type: "tool_execution_start",
		toolCallId: `tool-${currentTurn}`,
		toolName: "read",
		args: { path: `src/turn-${currentTurn}.ts` },
	});
	const delay = parseDelay(message);
	activeTimer = setTimeout(() => {
		activeTimer = null;
		emit({ type: "tool_execution_end", toolCallId: `tool-${currentTurn}`, toolName: "read", isError: false });
		if (message.includes("[retry]")) {
			emitAssistantEnd({ text: "first attempt failed", stopReason: "error", errorMessage: "transient failure", currentTurn });
			emit({ type: "agent_start" });
			emit({
				type: "tool_execution_start",
				toolCallId: `tool-${currentTurn}-retry`,
				toolName: "grep",
				args: { pattern: "retry", path: "src" },
			});
			activeTimer = setTimeout(() => {
				activeTimer = null;
				emit({ type: "tool_execution_end", toolCallId: `tool-${currentTurn}-retry`, toolName: "grep", isError: false });
				emitAssistantEnd({ text: `retry success: ${message}`, currentTurn });
				emit({ type: "agent_settled" });
			}, 20);
			return;
		}
		const isError = message.includes("[error]");
		const longMatch = /\[long=(\d+)\]/.exec(message);
		const text =
			message === "show_argv"
				? `argv:${argv.join("|")}`
				: longMatch
					? "界".repeat(Number.parseInt(longMatch[1], 10))
					: `turn ${currentTurn}: ${message.replace(/\s+/g, " ").trim()}`;
		emitAssistantEnd({
			text,
			stopReason: isError ? "error" : "stop",
			errorMessage: isError ? "synthetic failure" : undefined,
			currentTurn,
		});
		emit({ type: "agent_settled" });
	}, delay);
}

rl.on("line", (line) => {
	if (!line.trim()) return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	switch (command.type) {
		case "prompt":
		case "follow_up":
		case "steer":
			if (String(command.message ?? "").includes("[reject]")) {
				respond(command, false, "synthetic command rejection");
				break;
			}
			respond(command);
			runTurn(String(command.message ?? ""));
			break;
		case "extension_ui_response":
			if (pendingUi && command.id === pendingUi.id && command.cancelled === true) {
				const { currentTurn } = pendingUi;
				pendingUi = null;
				emitAssistantEnd({ text: "extension UI was cancelled", currentTurn });
				emit({ type: "agent_settled" });
			}
			break;
		case "abort":
			if (activeTimer) {
				clearTimeout(activeTimer);
				activeTimer = null;
			}
			pendingUi = null;
			respond(command);
			emit({ type: "agent_settled" });
			break;
		default:
			respond(command, false, `Unsupported fake command: ${command.type}`);
	}
});
rl.on("close", () => {
	if (activeTimer) clearTimeout(activeTimer);
	process.exit(0);
});
