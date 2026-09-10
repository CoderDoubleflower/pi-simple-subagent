import * as path from "node:path";
import type { AgentManager } from "./agent-manager.ts";
import { resolveProfileName } from "./guidance.ts";
import { canonicalPath, describeScopes, normalizeScopes, scopesOverlap, toolWritePaths, type WriteScope } from "./ownership.ts";
import type { AgentSnapshot, AgentStatus, ParentDispatchDefaults, SpawnAgentRequest } from "./types.ts";

type ManagerPort = Pick<AgentManager, "config" | "subscribe" | "spawn" | "sendInput" | "close" | "list">;
export type OwnedSpawnRequest = SpawnAgentRequest & { writeScope?: string[] };
export interface AgentDisplay {
	id: string; taskName: string; profileName: string; status: AgentStatus;
	startedAt: number; completedAt?: number; toolUses: number; showElapsed: boolean; showToolCount: boolean;
}
export interface Completion {
	agent_id: string; task_name: string; round: number; status: AgentStatus; output?: string; error?: string;
}
interface RecordState { snapshot: AgentSnapshot; round: number; delivered: number; scopes: WriteScope[] }
interface Waiter { ids: Set<string>; check(): void; abort(): void }
const running = (status: AgentStatus) => status === "running" || status === "starting";
const deliverable = (record: RecordState) => !running(record.snapshot.status) && record.snapshot.status !== "closed" && record.delivered < record.round;
function aborted(): Error { const error = new Error("Subagent operation cancelled."); error.name = "AbortError"; return error; }

/** Session-local ownership and exactly-once delivery, separate from Pi's rendering and child RPC. */
export class SubagentCoordinator {
	private readonly records = new Map<string, RecordState>();
	private readonly pendingScopes = new Map<string, WriteScope[]>();
	private readonly starts = new Map<AbortController, Promise<void>>();
	private readonly parentWrites = new Map<string, WriteScope[]>();
	private readonly busyAgents = new Set<string>();
	private readonly waiters = new Set<Waiter>();
	private readonly displayListeners = new Set<() => void>();
	private readonly unsubscribe: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private holds = 0;
	private generation = 0;
	private muted = false;
	private disposed = false;
	private cancellation: Promise<void> = Promise.resolve();

	readonly manager: ManagerPort;
	private readonly deliver: (results: Completion[]) => void;
	constructor(manager: ManagerPort, deliver: (results: Completion[]) => void) {
		this.manager = manager; this.deliver = deliver;
		this.unsubscribe = manager.subscribe((snapshot) => this.accept(snapshot));
	}
	subscribeDisplay(listener: () => void): () => void {
		this.displayListeners.add(listener);
		return () => { this.displayListeners.delete(listener); };
	}
	display(): AgentDisplay[] {
		return [...this.records.values()].filter((record) => record.snapshot.status !== "closed").map(({ snapshot: s }) => ({
			id: s.id, taskName: s.taskName, profileName: s.profileName, status: s.status, startedAt: s.startedAt,
			completedAt: s.completedAt, toolUses: s.activities.filter((item) => item.kind === "tool").length,
			showElapsed: s.display.showElapsed, showToolCount: s.display.showToolActivity,
		}));
	}
	list(): Array<Record<string, unknown>> {
		return [...this.records.values()].filter((record) => record.snapshot.status !== "closed").map((record) => ({
			agent_id: record.snapshot.id, task_name: record.snapshot.taskName, agent_type: record.snapshot.profileName,
			status: record.snapshot.status, round: record.round, result_delivered: record.delivered === record.round,
			write_scope: describeScopes(record.scopes),
		}));
	}
	ownershipContext(): string {
		const owned = this.list().filter((item) => item.status === "running" || item.status === "starting");
		return owned.length ? `Active delegated task ownership (do not redo these tasks or write their scopes):\n${JSON.stringify(owned)}\nContinue independent work, otherwise wait_agent once. A wait timeout does not transfer ownership.` : "";
	}

	async spawn(request: OwnedSpawnRequest, parent: ParentDispatchDefaults, signal?: AbortSignal): Promise<AgentSnapshot> {
		await this.cancellation;
		if (this.disposed || signal?.aborted) throw aborted();
		this.muted = false;
		const generation = this.generation;
		const profileName = resolveProfileName(request.profileName, this.manager.config);
		const cwd = path.resolve(parent.cwd, request.cwd ?? this.manager.config.profiles[profileName].cwd ?? parent.cwd);
		const scopes = normalizeScopes(request.writeScope ?? [], cwd);
		if (profileName === "worker" && !scopes.length) throw new Error("worker requires a non-empty write_scope. Specify the files or directories it owns, or use explorer for read-only work.");
		const taskName = request.taskName.trim().toLowerCase();
		if (this.pendingScopes.has(taskName)) throw new Error(`A subagent named "${taskName}" is already starting.`);
		this.assertAvailable(scopes);
		this.pendingScopes.set(taskName, scopes); // Reserve before the asynchronous child startup.
		const startupAbort = new AbortController();
		const startupSignal = signal ? AbortSignal.any([signal, startupAbort.signal]) : startupAbort.signal;
		let finishStartup!: () => void;
		this.starts.set(startupAbort, new Promise<void>((resolve) => { finishStartup = resolve; }));
		this.holds++;
		try {
			const message = scopes.length ? `${request.message}\n\nOwned write scope: ${describeScopes(scopes).join(", ")}. Modify only files in this scope. Other agents may be working concurrently; do not revert their changes.` : request.message;
			const snapshot = await this.manager.spawn({ ...request, taskName, profileName, message }, parent, startupSignal);
			if (this.disposed || generation !== this.generation || signal?.aborted) {
				await this.manager.close(snapshot.id);
				throw aborted();
			}
			this.accept(snapshot);
			return snapshot;
		} catch (error) {
			for (const [id, record] of this.records) if (record.snapshot.taskName === taskName && !this.manager.list().some((s) => s.id === id)) this.records.delete(id);
			throw error;
		} finally {
			if (this.pendingScopes.get(taskName) === scopes) this.pendingScopes.delete(taskName);
			this.starts.delete(startupAbort);
			finishStartup();
			this.holds--;
			this.changed();
		}
	}

	async sendInput(target: string, message: string, interrupt: boolean, signal?: AbortSignal) {
		const record = this.require(target);
		const id = record.snapshot.id;
		if (this.busyAgents.has(id)) throw new Error(`Subagent ${id} already has an input/close operation in progress.`);
		this.assertAvailable(record.scopes, id);
		const previous = { ...record, snapshot: structuredClone(record.snapshot) };
		this.busyAgents.add(id);
		this.holds++;
		try {
			const result = await this.manager.sendInput(id, message, interrupt, signal);
			this.accept(result.snapshot);
			return result;
		} catch (error) {
			// AgentProcess restores the previous snapshot when an idle prompt is rejected.
			// Restore its delivery round too; an unsuccessful follow-up is not a new result.
			const actual = this.manager.list().find((s) => s.id === id);
			if (actual && actual.status === previous.snapshot.status && actual.completedAt === previous.snapshot.completedAt && !this.muted) {
				this.records.set(id, { ...previous, snapshot: actual });
			}
			throw error;
		} finally { this.busyAgents.delete(id); this.holds--; this.changed(); }
	}

	async close(target: string): Promise<{ status: string }> {
		const record = this.find(target);
		if (!record) return { status: "not_found" };
		const id = record.snapshot.id;
		if (this.busyAgents.has(id)) throw new Error(`Subagent ${id} already has an input/close operation in progress.`);
		this.busyAgents.add(id);
		this.holds++;
		try {
			await this.manager.close(id);
			this.records.delete(id);
			return { status: "closed" };
		} finally { this.busyAgents.delete(id); this.holds--; this.changed(); }
	}

	/** No default deadline: periodic UI repaint must never become a model-visible poll. */
	async wait(targets: string[], timeoutMs?: number, signal?: AbortSignal) {
		if (this.disposed || this.muted || signal?.aborted) throw aborted();
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isInteger(timeoutMs))) throw new Error("timeout_ms must be a non-negative integer.");
		const names = [...new Set(targets.map((name) => name.trim()).filter(Boolean))];
		if (!names.length) throw new Error("wait_agent requires at least one non-empty target.");
		const requested = names.map((name) => ({ name, id: this.find(name)?.snapshot.id }));
		const ids = new Set(requested.flatMap(({ id }) => id ? [id] : []));
		const deadline = timeoutMs ? Math.min(this.manager.config.maxWaitTimeoutMs, Math.max(1_000, timeoutMs)) : undefined;
		let timedOut = false;
		await new Promise<void>((resolve, reject) => {
			let done = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.waiters.delete(waiter);
				if (error) reject(error); else resolve();
			};
			const onAbort = () => finish(aborted());
			const waiter: Waiter = {
				ids, abort: onAbort,
				check: () => {
					if (this.disposed || this.muted) return onAbort();
					if (this.holds) return;
					const records = [...ids].flatMap((id) => this.records.get(id) ? [this.records.get(id)!] : []);
					if (requested.some(({ id }) => !id) || records.some(deliverable) || !records.some((r) => running(r.snapshot.status))) finish();
				},
			};
			this.waiters.add(waiter); // Reserve delivery before checking terminal state.
			if (deadline !== undefined) timer = setTimeout(() => { timedOut = true; finish(); }, deadline);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort(); else waiter.check();
		});
		// Promise continuations run before the notification timer, so only one path claims a round.
		const results = [...ids].flatMap((id) => {
			const record = this.records.get(id);
			return record && deliverable(record) ? [this.claim(record)] : [];
		});
		const status = Object.fromEntries(requested.map(({ name, id }) => [name, id ? this.records.get(id)?.snapshot.status ?? "closed" : "not_found"]));
		this.scheduleDelivery();
		return { status, results, timed_out: timedOut, all_finished: !Object.values(status).some((value) => value === "starting" || value === "running") };
	}

	checkParentWrite(toolCallId: string, toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
		const paths = toolWritePaths(toolName, input);
		if (paths === undefined) return undefined;
		const scopes = paths.map((file) => ({ path: canonicalPath(file, cwd), tree: false }));
		if (!scopes.length && [...this.records.values()].some((r) => running(r.snapshot.status) && r.scopes.length)) {
			return "Cannot determine this write tool's destination while delegated write scopes are active. Use explicit file paths; do not bypass ownership with shell commands.";
		}
		try { this.assertAvailable(scopes); } catch (error) { return (error as Error).message; }
		this.parentWrites.set(toolCallId, scopes);
		return undefined;
	}
	finishParentWrite(toolCallId: string): void { this.parentWrites.delete(toolCallId); }

	cancel(): Promise<void> {
		this.muted = true;
		this.generation++;
		clearTimeout(this.timer); this.timer = undefined;
		for (const waiter of [...this.waiters]) waiter.abort();
		this.records.clear(); this.pendingScopes.clear(); this.parentWrites.clear();
		this.changed();
		// Abort and join startup before closing. Closing a child before start() has
		// assigned its process handle can otherwise leave an orphan when startup resumes.
		const starts = [...this.starts];
		for (const [controller] of starts) controller.abort();
		this.cancellation = Promise.allSettled(starts.map(([, done]) => done)).then(async () => {
			await Promise.allSettled(this.manager.list().map((s) => this.manager.close(s.id)));
		});
		return this.cancellation;
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		await this.cancel();
		this.displayListeners.clear();
	}

	private find(target: string): RecordState | undefined {
		const name = target.trim();
		return this.records.get(name) ?? [...this.records.values()].find((r) => r.snapshot.taskName === name);
	}
	private require(target: string): RecordState {
		if (this.disposed || this.muted) throw aborted();
		const record = this.find(target);
		if (!record) throw new Error(`Unknown subagent: ${target}`);
		return record;
	}
	private assertAvailable(scopes: WriteScope[], exceptId?: string): void {
		const overlaps = (other: WriteScope[]) => scopes.some((s) => other.some((o) => scopesOverlap(s, o)));
		for (const [id, record] of this.records) {
			if (id !== exceptId && running(record.snapshot.status) && overlaps(record.scopes)) {
				throw new Error(`Write scope belongs to running subagent ${record.snapshot.taskName} (${id}). Continue non-overlapping work, wait_agent, or close_agent before an explicit takeover. Do not use a shell command to bypass ownership.`);
			}
		}
		for (const [name, owned] of this.pendingScopes) if (overlaps(owned)) throw new Error(`Write scope is reserved by starting subagent ${name}.`);
		for (const owned of this.parentWrites.values()) if (overlaps(owned)) throw new Error("Write scope overlaps a parent file-writing tool that is still executing.");
	}
	private accept(snapshot: AgentSnapshot): void {
		if (this.disposed || this.muted) return;
		const previous = this.records.get(snapshot.id);
		const nextRound = previous && !running(previous.snapshot.status) && running(snapshot.status);
		this.records.set(snapshot.id, {
			snapshot, round: previous ? previous.round + (nextRound ? 1 : 0) : 1,
			delivered: previous?.delivered ?? 0, scopes: previous?.scopes ?? this.pendingScopes.get(snapshot.taskName) ?? [],
		});
		this.changed();
	}
	private claim(record: RecordState): Completion {
		record.delivered = record.round;
		const s = record.snapshot;
		return { agent_id: s.id, task_name: s.taskName, round: record.round, status: s.status,
			...(s.status === "completed" ? { output: s.finalOutput } : { error: s.error || "Subagent did not complete successfully." }) };
	}
	private changed(): void {
		for (const listener of this.displayListeners) listener();
		if (!this.holds) for (const waiter of [...this.waiters]) waiter.check();
		this.scheduleDelivery();
	}
	private scheduleDelivery(): void {
		if (this.disposed || this.muted || this.holds || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.muted || this.holds) return;
			const ready = [...this.records.values()].filter((r) => deliverable(r) && ![...this.waiters].some((w) => w.ids.has(r.snapshot.id)));
			if (!ready.length) return;
			const previous = ready.map((r) => r.delivered);
			const results = ready.map((r) => this.claim(r));
			try { this.deliver(results); } catch {
				// Keep failed deliveries available to wait_agent; never create a retry/spin loop.
				ready.forEach((r, index) => { r.delivered = previous[index]; });
			}
		}, 0);
	}
}
