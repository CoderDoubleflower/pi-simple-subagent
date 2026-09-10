import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLineDecoder } from "./jsonl.ts";
export type ChildEvent = Record<string, unknown>;
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface RpcProcessOptions {
	command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
	onEvent(event: ChildEvent): void; onStderr(text: string): void; onExit(message: string): void;
}
/** One private RPC connection; only its owner writes child stdin. */
export class RpcProcess {
	private child?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, Pending>();
	private readonly decoder = new JsonLineDecoder();
	private sequence = 0;
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly options: RpcProcessOptions;
	constructor(options: RpcProcessOptions) { this.options = options; }
	// `killed` only means a signal was sent, not that the process exited.
	get alive(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }
	async start(signal?: AbortSignal): Promise<void> {
		if (this.child || this.closing || signal?.aborted) throw new Error("Subagent start aborted or already started.");
		const o = this.options;
		const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => { for (const line of this.decoder.push(chunk)) this.line(line); });
		child.stderr.on("data", (chunk: Buffer) => o.onStderr(chunk.toString("utf8")));
		child.stdin.on("error", (error: Error) => this.rejectPending(error));
		child.on("error", (error: Error) => { this.rejectPending(error); if (!this.closing) o.onExit(error.message); });
		child.on("close", (code, processSignal) => {
			for (const line of this.decoder.end()) this.line(line);
			const message = `Process exited before it was closed (${code ?? processSignal ?? "unknown"}).`;
			this.rejectPending(new Error(message)); if (!this.closing) o.onExit(message);
		});
		await new Promise<void>((resolve, reject) => {
			let done = false;
			const finish = (error?: Error) => {
				if (done) return; done = true; clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort); child.removeListener("spawn", onSpawn); child.removeListener("error", onError);
				if (error) reject(error); else resolve();
			};
			const onSpawn = () => finish(); const onError = (error: Error) => finish(error);
			const onAbort = () => finish(new Error("Subagent start aborted."));
			const timer = setTimeout(() => finish(new Error("Subagent process startup timed out.")), o.timeoutMs);
			child.once("spawn", onSpawn); child.once("error", onError);
			signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort();
		});
	}
	request(command: ChildEvent, signal?: AbortSignal, timeoutMs = this.options.timeoutMs): Promise<unknown> {
		if (!this.child?.stdin.writable) return Promise.reject(new Error("Subagent RPC stdin is unavailable."));
		const id = `rpc_${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const cleanup = () => { const p = this.pending.get(id); if (p) clearTimeout(p.timer); this.pending.delete(id); signal?.removeEventListener("abort", onAbort); };
			const fail = (error: Error) => { cleanup(); reject(error); };
			const onAbort = () => fail(new Error(`RPC command ${String(command.type)} aborted.`));
			const timer = setTimeout(() => fail(new Error(`RPC command ${String(command.type)} timed out after ${timeoutMs}ms.`)), timeoutMs);
			this.pending.set(id, { timer, resolve: (value) => { cleanup(); resolve(value); }, reject: fail });
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) { onAbort(); return; }
			try { this.write({ ...command, id }); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
		});
	}
	write(value: ChildEvent): void {
		if (!this.child?.stdin.writable) throw new Error("Subagent RPC stdin is unavailable.");
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}
	close(graceMs: number, forceMs: number): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			if (this.alive) {
				try { await this.request({ type: "abort" }, undefined, Math.min(1000, graceMs)); } catch { /* Child may already be exiting. */ }
				await this.signalAndWait("SIGTERM", graceMs);
				if (this.alive) await this.signalAndWait("SIGKILL", forceMs);
			}
			this.rejectPending(new Error("Subagent process closed."));
		})();
		return this.closePromise;
	}
	private async signalAndWait(signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => { if (done) return; done = true; clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
			const timer = setTimeout(finish, timeoutMs); child.once("exit", finish);
			try { child.kill(signal); } catch { finish(); }
			if (child.exitCode !== null || child.signalCode !== null) finish();
		});
	}
	private rejectPending(error: Error): void { for (const pending of [...this.pending.values()]) pending.reject(error); }
	private line(line: string): void {
		if (!line.trim()) return;
		let event: ChildEvent;
		try { event = JSON.parse(line) as ChildEvent; }
		catch { this.options.onStderr(`[rpc stdout] ignored non-JSON line: ${line}\n`); return; }
		if (!event || typeof event !== "object") return;
		if (event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (event.success === false) pending?.reject(new Error(typeof event.error === "string" ? event.error : "RPC command failed."));
			else pending?.resolve(event.data);
		} else this.options.onEvent(event);
	}
}
