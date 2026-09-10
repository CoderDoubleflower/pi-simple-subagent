import { stripVTControlCharacters } from "node:util";
import { extractText } from "./process-formatting.ts";
import type { ChildEvent } from "./rpc-process.ts";
export interface ConversationLine { key: string; role: string; text: string }
export function safeText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, 32768);
}
function line(message: unknown): ConversationLine | undefined {
	if (!message || typeof message !== "object") return;
	const m = message as Record<string, unknown>;
	if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") return;
	const text = m.role === "toolResult" ? `[${String(m.toolName ?? "Tool")}${m.isError ? " failed" : " finished"}]` : extractText(message);
	if (!text.trim()) return;
	const clean = safeText(text);
	return { key: JSON.stringify([m.role, m.timestamp, m.toolCallId, clean]), role: m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool", text: clean };
}
/** Bounded display cache; the real conversation remains inside the child process. */
export class ConversationMirror {
	private entries: ConversationLine[] = [];
	private stream?: ConversationLine;
	get messages(): ConversationLine[] { return this.stream ? [...this.entries, this.stream] : [...this.entries]; }
	replace(messages: unknown[]): void {
		this.entries = []; this.stream = undefined;
		for (const message of messages) { const item = line(message); if (item) this.append(item); }
	}
	accept(event: ChildEvent): void {
		if (event.type === "message_update" || event.type === "message_start") {
			const item = line(event.message); if (item?.role === "Assistant") this.stream = item;
		} else if (event.type === "message_end") {
			const item = line(event.message);
			if (item) { if (item.role === "Assistant") this.stream = undefined; this.append(item); }
		} else if (event.type === "agent_settled") this.stream = undefined;
	}
	private append(item: ConversationLine): void {
		if (this.entries.some((entry) => entry.key === item.key)) return;
		this.entries.push(item);
		let size = this.entries.reduce((sum, entry) => sum + entry.text.length, 0);
		while (this.entries.length > 200 || (size > 262144 && this.entries.length > 1)) size -= this.entries.shift()!.text.length;
	}
}
