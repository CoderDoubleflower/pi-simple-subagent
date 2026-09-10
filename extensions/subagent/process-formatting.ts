import type { UsageStats } from "./types.ts";
export function byteTruncate(value: string, maxBytes: number, marker = "\n\n[Output truncated by pi-simple-subagent]"): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const budget = markerBytes < maxBytes ? maxBytes - markerBytes : maxBytes;
	let result = "", used = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > budget) break;
		result += character; used += bytes;
	}
	return result + (markerBytes < maxBytes ? marker : "");
}
export function extractText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
export function emptyUsage(): UsageStats { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }; }
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export function readUsage(message: Record<string, unknown>): UsageStats | undefined {
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const r = usage as Record<string, unknown>;
	const cost = r.cost && typeof r.cost === "object" ? r.cost as Record<string, unknown> : undefined;
	return { input: finite(r.input ?? r.inputTokens), output: finite(r.output ?? r.outputTokens),
		cacheRead: finite(r.cacheRead ?? r.cacheReadTokens), cacheWrite: finite(r.cacheWrite ?? r.cacheWriteTokens),
		cost: finite(r.cost) || finite(cost?.total), turns: 1 };
}
export function toolSummary(name: string, args: unknown): string {
	const r = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const short = (v: unknown, max = 88) => { const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""; return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
	switch (name) {
		case "read": case "write": case "edit": case "ls": return short(r.path ?? r.file_path) || name;
		case "grep": case "find": return `${short(r.pattern, 40)}${r.path ? ` in ${short(r.path, 45)}` : ""}`.trim() || name;
		case "bash": case "shell_command": case "powershell": return short(r.command) || name;
		case "apply_patch": return short(r.patch ?? r.input) || name;
		case "web_search": return short(r.query ?? r.q) || name;
		default: { const text = JSON.stringify(r); return text === "{}" ? name : short(text); }
	}
}
