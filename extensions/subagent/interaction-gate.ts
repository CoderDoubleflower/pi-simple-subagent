function aborted(): Error { const error = new Error("Subagent view or parent session closed."); error.name = "AbortError"; return error; }

/** Suspend parent tool boundaries during direct child interaction without stopping the child. */
export class InteractionGate {
	private active = false;
	private closed = false;
	private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
	get isOpen(): boolean { return this.active; }
	enter(): () => void {
		if (this.closed) throw aborted();
		if (this.active) throw new Error("The agents view is already open.");
		this.active = true;
		let released = false;
		return () => {
			if (released) return; released = true; this.active = false;
			for (const waiter of [...this.waiters]) waiter.resolve();
		};
	}
	async wait(signal?: AbortSignal): Promise<void> {
		if (this.closed || signal?.aborted) throw aborted();
		if (!this.active) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => { this.waiters.delete(waiter); signal?.removeEventListener("abort", onAbort); };
			const waiter = { resolve: () => { cleanup(); resolve(); }, reject: (error: Error) => { cleanup(); reject(error); } };
			const onAbort = () => waiter.reject(aborted());
			this.waiters.add(waiter); signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}
	dispose(): void {
		this.closed = true; this.active = false;
		for (const waiter of [...this.waiters]) waiter.reject(aborted());
	}
}
