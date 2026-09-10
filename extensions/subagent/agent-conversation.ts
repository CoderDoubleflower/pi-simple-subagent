import type { AgentManager } from "./agent-manager.ts";
import type { ChildEvent } from "./rpc-process.ts";
import { ConversationMirror } from "./conversation-mirror.ts";

type ManagerPort = Pick<AgentManager, "list" | "subscribe" | "getMessages" | "subscribeEvents">;
export type SendPrompt = (target: string, text: string, interrupt: boolean) => Promise<unknown>;

/** A view of the same live RPC context; never writes prompts into the parent session. */
export class AgentConversation {
	readonly mirror = new ConversationMirror();
	selected?: string;
	info = "Select an agent to enter its context.";
	loading = false;
	private generation = 0;
	private disposed = false;
	private readAbort?: AbortController;
	private unsubscribeEvents?: () => void;
	private readonly unsubscribeSnapshots: () => void;
	private pendingSend?: Promise<void>;
	private readonly manager: ManagerPort;
	private readonly sendPrompt: SendPrompt;
	private readonly changed: () => void;
	constructor(manager: ManagerPort, sendPrompt: SendPrompt, changed: () => void) {
		this.manager = manager; this.sendPrompt = sendPrompt; this.changed = changed;
		this.unsubscribeSnapshots = manager.subscribe(() => { if (!this.disposed) changed(); });
	}
	list() { return this.manager.list(); }
	get snapshot() { return this.manager.list().find((agent) => agent.id === this.selected); }
	get sending(): boolean { return !!this.pendingSend; }
	async select(target: string): Promise<void> {
		this.leave();
		if (this.disposed) return;
		const snapshot = this.manager.list().find((agent) => agent.id === target || agent.taskName === target);
		if (!snapshot) { this.info = "This agent is no longer available."; this.changed(); return; }
		this.selected = snapshot.id; this.loading = true; this.info = "Loading conversation…";
		const token = this.generation;
		const abort = new AbortController(); this.readAbort = abort;
		const buffered: ChildEvent[] = [];
		try {
			this.unsubscribeEvents = this.manager.subscribeEvents(snapshot.id, (event) => {
				if (this.disposed || this.generation !== token) return;
				if (this.loading) { buffered.push(event); if (buffered.length > 1000) buffered.shift(); }
				else { this.mirror.accept(event); this.changed(); }
			});
			this.changed();
			const messages = await this.manager.getMessages(snapshot.id, abort.signal);
			if (this.disposed || this.generation !== token) return;
			this.mirror.replace(messages);
			// The RPC snapshot may already contain buffered message_end events. The mirror deduplicates them.
			for (const event of buffered) this.mirror.accept(event);
			this.info = "Private child context · prompts go only to this agent.";
		} catch (error) {
			if (this.generation === token && !this.disposed) this.info = `Cannot load conversation: ${error instanceof Error ? error.message : String(error)}`;
		} finally { if (this.generation === token && !this.disposed) { this.loading = false; this.changed(); } }
	}
	async send(text: string, interrupt: boolean): Promise<void> {
		const target = this.selected;
		if (!target || this.disposed) throw new Error("No agent selected.");
		if (this.loading) throw new Error("Wait for the child conversation to load.");
		if (this.pendingSend) throw new Error("A prompt is already being submitted.");
		const message = text.trim();
		if (!message) throw new Error("Prompt must not be empty.");
		if (message.startsWith("/")) throw new Error("This view accepts prompts, not child slash commands.");
		const token = this.generation;
		const running = this.snapshot?.status === "running" || this.snapshot?.status === "starting";
		this.info = "Sending prompt…";
		const operation = (async () => {
			await this.sendPrompt(target, message, interrupt);
			if (!this.disposed && token === this.generation) this.info = running ? interrupt ? "Steering message sent." : "Follow-up queued." : "Prompt sent · continuing the same context.";
		})();
		this.pendingSend = operation; this.changed();
		try { await operation; }
		finally { if (this.pendingSend === operation) this.pendingSend = undefined; if (!this.disposed) this.changed(); }
	}
	async settleInput(): Promise<void> { await this.pendingSend?.catch(() => undefined); }
	leave(): void {
		this.generation++; this.readAbort?.abort(); this.readAbort = undefined;
		this.unsubscribeEvents?.(); this.unsubscribeEvents = undefined;
		this.selected = undefined; this.loading = false; this.mirror.replace([]);
	}
	dispose(): void {
		if (this.disposed) return; this.disposed = true; this.leave(); this.unsubscribeSnapshots();
	}
}
