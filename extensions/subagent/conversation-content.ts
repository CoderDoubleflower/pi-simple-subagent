import { stripVTControlCharacters } from "node:util";

export interface ConversationMessage extends Record<string, unknown> {
	role: string;
	content: Array<Record<string, unknown>>;
}
export interface ConversationItem { key: string; message: ConversationMessage; streaming: boolean }
export interface ConversationLine { key: string; role: string; text: string }
export const MAX_BLOCKS = 256;
export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function safeText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, 32768);
}
/** Bounded copies for display only. Signatures and image payloads are never rendered. */
export function displayValue(value: unknown, depth = 0, budget = { remaining: 131072 }): unknown {
	if (budget.remaining <= 0 || depth > 12) return "[Display truncated; child context unchanged]";
	if (typeof value === "string") {
		const text = safeText(value).slice(0, budget.remaining); budget.remaining -= text.length;
		return value.length > 32768 ? `${text}\n[Display truncated; child context unchanged]` : text;
	}
	if (Array.isArray(value)) return value.slice(0, MAX_BLOCKS).map((item) => displayValue(item, depth + 1, budget));
	if (value && typeof value === "object") {
		if (record(value).type === "image") return { type: "text", text: "[Image omitted from child view]" };
		return Object.fromEntries(Object.entries(value).slice(0, MAX_BLOCKS)
			.filter(([key]) => !["__proto__", "constructor", "prototype", "thinkingSignature", "textSignature"].includes(key))
			.map(([key, item]) => [safeText(key), displayValue(item, depth + 1, budget)]));
	}
	return value;
}
export function displayMessage(value: unknown): ConversationMessage | undefined {
	let source = record(value);
	if (source.type === "message" && source.message) source = record(source.message);
	if (!["user", "assistant", "toolResult", "custom"].includes(String(source.role))) return undefined;
	const copy = displayValue(source) as Record<string, unknown>;
	const content = typeof copy.content === "string" ? [{ type: "text", text: copy.content }]
		: Array.isArray(copy.content) ? copy.content.map(record) : [];
	return { ...copy, role: String(source.role), content };
}
export function messageIdentity(message: ConversationMessage): string {
	if (message.role === "toolResult" && message.toolCallId) return `tool:${String(message.toolCallId)}`;
	if (message.id) return `${message.role}:id:${String(message.id)}`;
	if (message.timestamp !== undefined) return `${message.role}:time:${String(message.timestamp)}`;
	return JSON.stringify([message.role, message.content]);
}
