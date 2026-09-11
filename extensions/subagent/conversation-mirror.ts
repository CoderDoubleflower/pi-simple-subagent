import { extractText } from "./process-formatting.ts";
import { AssistantStream } from "./assistant-stream.ts";
import { displayMessage, messageIdentity, record, safeText, type ConversationItem, type ConversationLine, type ConversationMessage } from "./conversation-content.ts";
import type { ChildEvent } from "./rpc-process.ts";
export { safeText } from "./conversation-content.ts";
export type { ConversationLine, ConversationItem } from "./conversation-content.ts";

/** Bounded private transcript; the actual conversation remains in the child. */
export class ConversationMirror {
	private entries: ConversationItem[] = [];
	private readonly stream = new AssistantStream();
	private ignoreStream = false;
	private dropped = 0;
	get items(): readonly ConversationItem[] {
		const message = this.stream.message;
		return message ? [...this.entries, { key: message.timestamp !== undefined || message.id ? messageIdentity(message) : "assistant:stream", message, streaming: true }] : [...this.entries];
	}
	get truncated(): boolean { return this.dropped > 0; }
	get streamingMessage(): ConversationMessage | undefined { return this.stream.message ? structuredClone(this.stream.message) : undefined; }
	/** Legacy text-only projection. Interactive rendering uses items, not this lossy projection. */
	get messages(): ConversationLine[] {
		return this.items.flatMap(({ key, message: m }) => {
			const text = m.role === "toolResult" ? `[${String(m.toolName ?? "Tool")}${m.isError ? " failed" : " finished"}]` : extractText(m);
			return text.trim() ? [{ key, role: m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool", text: safeText(text) }] : [];
		});
	}
	replace(messages: unknown[]): void {
		this.entries = []; this.stream.reset(); this.ignoreStream = false; this.dropped = 0;
		for (const value of messages) { const message = displayMessage(value); if (message) this.upsert(message); }
	}
	accept(event: ChildEvent): void {
		if (event.type === "message_start" || event.type === "message_update") {
			const message = displayMessage(event.message ?? record(event.assistantMessageEvent).partial);
			if (message && message.role !== "assistant") { this.upsert(message); return; }
			if (message) {
				// History may already contain the final message corresponding to a
				// buffered start/delta. Do not replace it with older partial content.
				this.ignoreStream = this.entries.some((item) => item.key === messageIdentity(message) && item.message.role === "assistant");
			}
			if (this.ignoreStream) { this.stream.reset(); return; }
			this.stream.accept(event); return;
		}
		if (event.type === "message_end") {
			const message = displayMessage(event.message);
			if (!message) return;
			if (message.role === "assistant") { this.stream.reset(); this.ignoreStream = false; }
			this.upsert(message); return;
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
			const id = String(event.toolCallId ?? event.id ?? "");
			if (!id) return;
			const previous = this.entries.find((item) => item.key === `tool:${id}`)?.message;
			const end = event.type === "tool_execution_end";
			if (previous && previous.isPartial === false && !end) return;
			const result = record(event.result ?? event.partialResult);
			const message = displayMessage({ ...previous, ...result, role: "toolResult", toolCallId: id,
				toolName: event.toolName ?? previous?.toolName ?? "Tool", arguments: event.args ?? previous?.arguments,
				content: result.content ?? previous?.content ?? [], isError: event.isError ?? result.isError ?? previous?.isError ?? false,
				executionStarted: true, isPartial: !end });
			if (message) this.upsert(message); return;
		}
		if (event.type === "agent_settled" && this.stream.message) {
			// Preserve partial content on interruption instead of erasing it.
			this.upsert(this.stream.message); this.stream.reset();
		}
	}
	private upsert(message: ConversationMessage): void {
		const key = messageIdentity(message);
		const index = this.entries.findIndex((item) => item.key === key);
		const previous = index >= 0 ? this.entries[index].message : undefined;
		if (message.role === "toolResult") message = { ...previous, ...message, isPartial: message.isPartial ?? false };
		const item = { key, message, streaming: false };
		if (index < 0) this.entries.push(item); else this.entries[index] = item;
		let size = this.entries.reduce((sum, entry) => sum + JSON.stringify(entry.message).length, 0);
		while (this.entries.length > 200 || (size > 1024 * 1024 && this.entries.length > 1)) {
			size -= JSON.stringify(this.entries.shift()!.message).length; this.dropped++;
		}
	}
}
