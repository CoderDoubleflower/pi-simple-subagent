import { displayMessage, displayValue, MAX_BLOCKS, record, safeText, type ConversationMessage } from "./conversation-content.ts";
import type { ChildEvent } from "./rpc-process.ts";

/** Reconstruct Pi JSON/RPC deltas; older cumulative snapshots remain supported. */
export class AssistantStream {
	message?: ConversationMessage;
	private readonly arguments = new Map<number, string>();
	reset(): void { this.message = undefined; this.arguments.clear(); }
	accept(event: ChildEvent): void {
		const delta = record(event.assistantMessageEvent);
		const cumulative = displayMessage(event.message ?? delta.partial);
		if (cumulative?.role === "assistant") {
			if (event.type === "message_start") this.arguments.clear();
			this.message = cumulative; return;
		}
		if (delta.type === "done" || delta.type === "error") {
			const final = displayMessage(delta.message ?? delta.error);
			if (final?.role === "assistant") this.message = final;
			return;
		}
		const index = delta.contentIndex;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_BLOCKS) return;
		const message = structuredClone(this.message ?? { role: "assistant", content: [] });
		const content = message.content;
		while (content.length <= index) content.push({ type: "text", text: "" });
		const block = content[index];
		const text = typeof delta.delta === "string" ? safeText(delta.delta) : "";
		switch (delta.type) {
			case "text_start": content[index] = { type: "text", text: "" }; break;
			case "text_delta": content[index] = { type: "text", text: safeText(String(block.text ?? "") + text) }; break;
			case "text_end": content[index] = { type: "text", text: typeof delta.content === "string" ? safeText(delta.content) : String(block.text ?? "") }; break;
			case "thinking_start": content[index] = { type: "thinking", thinking: "" }; break;
			case "thinking_delta": content[index] = { type: "thinking", thinking: safeText(String(block.thinking ?? "") + text) }; break;
			case "thinking_end": content[index] = { type: "thinking", thinking: typeof delta.content === "string" ? safeText(delta.content) : String(block.thinking ?? "") }; break;
			case "toolcall_start":
				content[index] = { type: "toolCall", id: String(delta.id ?? ""), name: String(delta.toolName ?? "Tool"), arguments: {} };
				this.arguments.set(index, ""); break;
			case "toolcall_delta": {
				const args = safeText((this.arguments.get(index) ?? "") + text); this.arguments.set(index, args);
				try { content[index] = { ...block, arguments: displayValue(JSON.parse(args)) }; } catch { /* Wait for complete arguments. */ }
				break;
			}
			case "toolcall_end":
				content[index] = { ...block, ...record(displayValue(delta.toolCall)), type: "toolCall" }; this.arguments.delete(index); break;
			default: return;
		}
		if (event.usage) message.usage = displayValue(event.usage);
		this.message = message;
	}
}
