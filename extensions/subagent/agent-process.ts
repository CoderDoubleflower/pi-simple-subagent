import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonLineDecoder } from "./jsonl.ts";
import type {
	AgentActivity,
	AgentSnapshot,
	AgentStatus,
	ResolvedAgentSettings,
	SubagentConfig,
	UsageStats,
} from "./types.ts";

type SnapshotListener = (snapshot: AgentSnapshot) => void;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface AgentProcessOptions {
	id: string;
	taskName: string;
	message: string;
	settings: ResolvedAgentSettings;
	config: SubagentConfig;
}

const BLOCKING_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let result = "";
	let used = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size > maxBytes) break;
		result += character;
		used += size;
	}
	return result;
}

export function byteTruncate(value: string, maxBytes: number, marker = "\n\n[Output truncated by pi-simple-subagent]"): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	if (markerBytes >= maxBytes) return utf8Prefix(value, maxBytes);
	return utf8Prefix(value, maxBytes - markerBytes) + marker;
}

function extractText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: string; text?: string } =>
				!!part && typeof part === "object" && typeof (part as { type?: unknown }).type === "string",
		)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text ?? "")
		.join("\n");
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(message: unknown): UsageStats | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const costRecord = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>) : undefined;
	return {
		input: finiteNumber(record.input ?? record.inputTokens),
		output: finiteNumber(record.output ?? record.outputTokens),
		cacheRead: finiteNumber(record.cacheRead ?? record.cacheReadTokens),
		cacheWrite: finiteNumber(record.cacheWrite ?? record.cacheWriteTokens),
		cost: finiteNumber(record.cost) || finiteNumber(costRecord?.total),
		turns: 1,
	};
}

function toolSummary(name: string, args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const shorten = (value: unknown, max = 88) => {
		const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
		return text.length > max ? `${text.slice(0, max - 1)}…` : text;
	};
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return shorten(record.path ?? record.file_path) || name;
		case "grep":
		case "find":
			return `${shorten(record.pattern, 40)}${record.path ? ` in ${shorten(record.path, 45)}` : ""}`.trim() || name;
		case "bash":
		case "shell_command":
		case "powershell":
			return shorten(record.command) || name;
		case "apply_patch":
			return shorten(record.patch ?? record.input, 88) || name;
		case "web_search":
			return shorten(record.query ?? record.q, 88) || name;
		default: {
			const serialized = JSON.stringify(record);
			return serialized === "{}" ? name : shorten(serialized);
		}
	}
}

export class AgentProcess {
	private readonly options: AgentProcessOptions;
	private child?: ChildProcessWithoutNullStreams;
	private readonly listeners = new Set<SnapshotListener>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly decoder = new JsonLineDecoder();
	private sequence = 0;
	private closePromise?: Promise<void>;
	private promptTempDir?: string;
	private snapshotValue: AgentSnapshot;
	private closing = false;
	private lastStopReason?: string;

	constructor(options: AgentProcessOptions) {
		this.options = options;
		const now = Date.now();
		this.snapshotValue = {
			id: options.id,
			taskName: options.taskName,
			profileName: options.settings.profileName,
			profileDescription: options.settings.profileDescription,
			message: options.message,
			status: "starting",
			finalOutput: "",
			stderr: "",
			model: options.settings.model,
			effort: options.settings.effort,
			tools: Array.isArray(options.settings.tools) ? [...options.settings.tools] : options.settings.tools,
			cwd: options.settings.cwd,
			usage: emptyUsage(),
			activities: [],
			startedAt: now,
			updatedAt: now,
		};
	}

	get snapshot(): AgentSnapshot {
		return structuredClone(this.snapshotValue);
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.child) throw new Error("Subagent process has already started.");
		const args = await this.buildArgs();
		const processConfig = this.options.config.process;
		const env: NodeJS.ProcessEnv = processConfig.inheritEnvironment ? { ...process.env } : {};
		Object.assign(env, processConfig.env, this.options.settings.env, { PI_SIMPLE_SUBAGENT_CHILD: "1" });

		const child = spawn(processConfig.command, args, {
			cwd: this.options.settings.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
		child.on("exit", (code, processSignal) => this.handleExit(code, processSignal));
		child.on("error", (error: Error) => this.handleChildError(error));

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				child.removeListener("spawn", onSpawn);
				child.removeListener("error", onError);
				if (error) reject(error);
				else resolve();
			};
			const onSpawn = () => finish();
			const onError = (error: Error) => finish(error);
			const onAbort = () => finish(new Error("Subagent start aborted."));
			timer = setTimeout(
				() => finish(new Error(`Timed out starting subagent RPC process after ${this.options.config.rpcStartupTimeoutMs}ms.`)),
				this.options.config.rpcStartupTimeoutMs,
			);
			child.once("spawn", onSpawn);
			child.once("error", onError);
			if (signal?.aborted) onAbort();
			else {
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			}
		});


		this.setStatus("running");
		try {
			await this.request({ type: "prompt", message: this.options.message }, this.options.config.rpcStartupTimeoutMs, signal);
		} catch (error) {
			this.fail(error);
			throw error;
		}
	}

	async sendInput(message: string, interrupt: boolean, signal?: AbortSignal): Promise<string> {
		if (this.snapshotValue.status === "closed") throw new Error(`Subagent ${this.options.id} is closed.`);
		if (!this.child || this.child.killed || this.hasExited(this.child)) throw new Error(`Subagent ${this.options.id} is not running.`);
		const submissionId = `submission_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const running = this.snapshotValue.status === "running" || this.snapshotValue.status === "starting";

		if (!running) {
			const previousSnapshot = this.snapshot;
			const previousStopReason = this.lastStopReason;
			this.prepareForTurn();
			try {
				await this.request({ type: "prompt", message }, this.options.config.rpcStartupTimeoutMs, signal);
			} catch (error) {
				this.snapshotValue = previousSnapshot;
				this.lastStopReason = previousStopReason;
				this.touch();
				throw error;
			}
		} else if (interrupt) {
			await this.request({ type: "steer", message }, this.options.config.rpcStartupTimeoutMs, signal);
		} else {
			await this.request({ type: "follow_up", message }, this.options.config.rpcStartupTimeoutMs, signal);
		}
		return submissionId;
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.performClose();
		return this.closePromise;
	}

	private async performClose(): Promise<void> {
		this.closing = true;
		const child = this.child;
		if (!child) {
			this.setStatus("closed");
			await this.cleanupTempPrompt();
			return;
		}
		if (!this.hasExited(child)) {
			try {
				await this.request({ type: "abort" }, Math.min(1_000, this.options.config.killGraceMs));
			} catch {
				// The process may already be exiting.
			}
			await this.signalAndWaitForExit(child, "SIGTERM", this.options.config.killGraceMs);
			if (!this.hasExited(child)) {
				await this.signalAndWaitForExit(child, "SIGKILL", this.options.config.killForceMs);
			}
		}
		this.rejectPending(new Error("Subagent process closed."));
		this.finishRunningActivities(true);
		this.setStatus("closed");
		this.child = undefined;
		await this.cleanupTempPrompt();
	}

	private signalAndWaitForExit(
		child: ChildProcessWithoutNullStreams,
		signal: NodeJS.Signals,
		timeoutMs: number,
	): Promise<void> {
		if (this.hasExited(child)) return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				child.removeListener("exit", onExit);
				resolve();
			};
			const onExit = () => finish();
			// Attach before kill(). A very short-lived child can otherwise exit between
			// kill() and once("exit"), forcing every close to wait for the full timeout.
			child.once("exit", onExit);
			timer = setTimeout(finish, Math.max(0, timeoutMs));
			try {
				child.kill(signal);
			} catch {
				finish();
				return;
			}
			if (this.hasExited(child)) finish();
		});
	}

	private hasExited(child: ChildProcessWithoutNullStreams): boolean {
		// exitCode remains null when a process exits because of a signal.
		return child.exitCode !== null || child.signalCode !== null;
	}

	private async buildArgs(): Promise<string[]> {
		const args = [
			...this.options.config.process.extraArgs,
			...this.options.settings.extraArgs,
			// Keep the transport/session invariants after user-provided arguments so
			// conflicting earlier flags cannot turn the child into an interactive or
			// persisted session. Pi resolves repeated scalar flags from left to right.
			"--mode",
			"rpc",
			"--no-session",
		];
		if (this.options.settings.model) args.push("--model", this.options.settings.model);
		if (this.options.settings.effort) args.push("--thinking", this.options.settings.effort);
		if (this.options.settings.tools === "none") args.push("--no-tools");
		else if (Array.isArray(this.options.settings.tools)) args.push("--tools", this.options.settings.tools.join(","));
		const excluded = [...new Set(this.options.config.process.excludeTools)];
		if (excluded.length > 0) args.push("--exclude-tools", excluded.join(","));
		args.push(this.options.settings.approveProject ? "--approve" : "--no-approve");
		if (this.options.settings.systemPrompt.trim()) {
			this.promptTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-simple-subagent-"));
			const promptPath = path.join(this.promptTempDir, "system-prompt.md");
			await fs.promises.writeFile(promptPath, this.options.settings.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		return args;
	}

	private handleStdout(chunk: Buffer): void {
		for (const line of this.decoder.push(chunk)) this.handleLine(line);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.appendStderr(`[rpc stdout] ignored non-JSON line: ${line}\n`);
			return;
		}

		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				this.pending.delete(event.id);
				clearTimeout(pending.timer);
				if (event.success === false) pending.reject(new Error(typeof event.error === "string" ? event.error : "RPC command failed."));
				else pending.resolve(event.data);
			}
			return;
		}

		if (event.type === "extension_ui_request" && typeof event.id === "string") {
			const method = typeof event.method === "string" ? event.method : "unknown";
			if (BLOCKING_UI_METHODS.has(method)) {
				this.appendStderr(`[extension_ui:${method}] auto-cancelled because the subagent has no interactive TUI.\n`);
				this.writeLine({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			return;
		}

		if (event.type === "agent_start" && !this.closing) this.prepareForTurn();

		if (event.type === "tool_execution_start") {
			const id = String(event.toolCallId ?? event.id ?? `activity_${++this.sequence}`);
			const name = String(event.toolName ?? event.name ?? "tool");
			this.pushActivity({
				id,
				kind: "tool",
				name,
				summary: toolSummary(name, event.args ?? event.arguments),
				status: "running",
				startedAt: Date.now(),
			});
		}

		if (event.type === "tool_execution_end") {
			const id = String(event.toolCallId ?? event.id ?? "");
			const activity = this.snapshotValue.activities.findLast((item) => item.id === id);
			if (activity) {
				activity.status = event.isError === true ? "errored" : "completed";
				activity.endedAt = Date.now();
				this.touch();
			}
		}

		if (event.type === "message_end") {
			const message = event.message;
			if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
				const text = extractText(message);
				if (text) this.snapshotValue.finalOutput = byteTruncate(text, this.options.config.output.maxFinalBytes);
				const usage = readUsage(message);
				if (usage) {
					this.snapshotValue.usage.input += usage.input;
					this.snapshotValue.usage.output += usage.output;
					this.snapshotValue.usage.cacheRead += usage.cacheRead;
					this.snapshotValue.usage.cacheWrite += usage.cacheWrite;
					this.snapshotValue.usage.cost += usage.cost;
					this.snapshotValue.usage.turns += usage.turns;
				}
				const stopReason = (message as { stopReason?: unknown }).stopReason;
				const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
				this.lastStopReason = typeof stopReason === "string" ? stopReason : undefined;
				if (stopReason === "error") {
					this.snapshotValue.error =
						typeof errorMessage === "string" && errorMessage.trim()
							? `Subagent turn error: ${errorMessage}`
							: "Subagent turn failed.";
				} else if (stopReason === "aborted") {
					this.snapshotValue.error =
						typeof errorMessage === "string" && errorMessage.trim() ? errorMessage : "Subagent turn was interrupted.";
				}
				this.touch();
			}
		}

		if (event.type === "agent_settled") {
			if (this.closing) return;
			this.finishRunningActivities(false);
			if (this.lastStopReason === "aborted") this.setStatus("interrupted");
			else if (this.snapshotValue.error) this.setStatus("errored");
			else this.setStatus("completed");
		}
	}

	private request(command: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error("Subagent RPC stdin is unavailable."));
		const id = `rpc_${this.options.id}_${++this.sequence}`;
		return new Promise((resolve, reject) => {
			let abortHandler: (() => void) | undefined;
			const finishReject = (error: Error) => {
				if (abortHandler) signal?.removeEventListener("abort", abortHandler);
				reject(error);
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				finishReject(new Error(`RPC command ${String(command.type)} timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					if (abortHandler) signal?.removeEventListener("abort", abortHandler);
					resolve(value);
				},
				reject: finishReject,
				timer,
			});
			abortHandler = () => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new Error(`RPC command ${String(command.type)} aborted.`));
			};
			if (signal?.aborted) {
				abortHandler();
				return;
			}
			signal?.addEventListener("abort", abortHandler, { once: true });
			if (signal?.aborted) {
				abortHandler();
				return;
			}
			try {
				this.writeLine({ ...command, id });
			} catch (error) {
				const pending = this.pending.get(id);
				if (pending) {
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
	}

	private writeLine(value: unknown): void {
		if (!this.child?.stdin.writable) throw new Error("Subagent RPC stdin is unavailable.");
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}


	private handleChildError(error: Error): void {
		this.appendStderr(`[process error] ${error.message}\n`);
		this.rejectPending(error);
		if (!this.closing && this.snapshotValue.status !== "closed") this.fail(error);
	}

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		for (const line of this.decoder.end()) this.handleLine(line);
		this.rejectPending(new Error(`Subagent process exited (${code ?? signal ?? "unknown"}).`));
		if (!this.closing && this.snapshotValue.status !== "closed") {
			this.snapshotValue.error = `Process exited before it was closed (${code ?? signal ?? "unknown"}).`;
			this.finishRunningActivities(true);
			this.setStatus("errored");
		}
		void this.cleanupTempPrompt();
	}

	private prepareForTurn(): void {
		if (this.closing) return;
		this.snapshotValue.finalOutput = "";
		this.snapshotValue.error = undefined;
		this.snapshotValue.completedAt = undefined;
		this.lastStopReason = undefined;
		this.setStatus("running");
	}

	private finishRunningActivities(asError: boolean): void {
		let changed = false;
		for (const activity of this.snapshotValue.activities) {
			if (activity.status !== "running") continue;
			activity.status = asError ? "errored" : "completed";
			activity.endedAt = Date.now();
			changed = true;
		}
		if (changed) this.touch();
	}

	private fail(error: unknown): void {
		this.snapshotValue.error = error instanceof Error ? error.message : String(error);
		this.lastStopReason = "error";
		this.setStatus("errored");
	}

	private appendStderr(text: string): void {
		this.snapshotValue.stderr = byteTruncate(
			this.snapshotValue.stderr + text,
			this.options.config.output.maxStderrBytes,
			"\n[stderr truncated by pi-simple-subagent]",
		);
		this.touch();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private pushActivity(activity: AgentActivity): void {
		this.snapshotValue.activities.push(activity);
		const max = this.options.config.output.maxActivityItems;
		if (this.snapshotValue.activities.length > max) {
			this.snapshotValue.activities.splice(0, this.snapshotValue.activities.length - max);
		}
		this.touch();
	}

	private setStatus(status: AgentStatus): void {
		this.snapshotValue.status = status;
		if (status === "completed" || status === "errored" || status === "interrupted" || status === "closed") {
			this.snapshotValue.completedAt ??= Date.now();
		}
		this.touch();
	}

	private touch(): void {
		this.snapshotValue.updatedAt = Date.now();
		const snapshot = this.snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}

	private async cleanupTempPrompt(): Promise<void> {
		if (!this.promptTempDir) return;
		const dir = this.promptTempDir;
		this.promptTempDir = undefined;
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}
