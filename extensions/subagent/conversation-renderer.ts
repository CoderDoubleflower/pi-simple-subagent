import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as Pi from "@earendil-works/pi-coding-agent";
import { Container, Markdown, type Component, type TUI } from "@earendil-works/pi-tui";
import { record, type ConversationItem, type ConversationMessage } from "./conversation-content.ts";
import { extractText } from "./process-formatting.ts";

type ToolDefinition = ConstructorParameters<typeof Pi.ToolExecutionComponent>[4];
interface Cached { signature: string; component: Component }
const FACTORIES: Record<string, string> = {
	read: "createReadToolDefinition", write: "createWriteToolDefinition", edit: "createEditToolDefinition",
	bash: "createBashToolDefinition", grep: "createGrepToolDefinition", find: "createFindToolDefinition", ls: "createLsToolDefinition",
};
function toolDefinition(name: string, cwd: string): ToolDefinition {
	const factoryName = FACTORIES[name];
	if (!factoryName) return undefined;
	const factory = (Pi as unknown as Record<string, unknown>)[factoryName];
	return typeof factory === "function" ? (factory as (cwd: string) => ToolDefinition)(cwd) : undefined;
}

/**
 * Reuse public host components, not copies of their styling. The active
 * pi-open-tui patches to these same prototypes apply to this view as well.
 * Only renderers are invoked: no child tool is executed by the parent UI.
 */
export class ConversationRenderer {
	private readonly root = new Container();
	private readonly cache = new Map<string, Cached>();
	private readonly ui: TUI;
	private disposed = false;
	private hideThinking = false;
	private expanded = false;
	private cwd = "";
	constructor(tui: TUI, requestRender: () => void = () => tui.requestRender()) {
		this.ui = Object.create(tui) as TUI;
		this.ui.requestRender = () => { if (!this.disposed) requestRender(); };
	}
	get thinkingHidden(): boolean { return this.hideThinking; }
	get toolsExpanded(): boolean { return this.expanded; }
	toggleThinking(): void {
		this.hideThinking = !this.hideThinking;
		for (const { component } of this.cache.values()) if (component instanceof Pi.AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
	}
	toggleTools(): void {
		this.expanded = !this.expanded;
		for (const { component } of this.cache.values()) if (component instanceof Pi.ToolExecutionComponent) component.setExpanded(this.expanded);
	}
	reset(): void {
		for (const { component } of this.cache.values()) (component as Component & { dispose?: () => void }).dispose?.();
		this.cache.clear(); this.root.clear();
	}
	invalidate(): void { for (const { component } of this.cache.values()) component.invalidate(); }
	dispose(): void { if (!this.disposed) { this.disposed = true; this.reset(); } }

	render(items: readonly ConversationItem[], width: number, cwd: string): string[] {
		if (this.disposed || width <= 0) return [];
		if (cwd !== this.cwd) { this.reset(); this.cwd = cwd; }
		const wanted = new Set<string>();
		const seenTools = new Set<string>();
		const results = new Map<string, ConversationMessage>();
		for (const { message } of items) if (message.role === "toolResult") results.set(String(message.toolCallId ?? ""), message);
		this.root.clear();
		const add = (key: string, signature: string, create: () => Component, update?: (component: Component) => void) => {
			wanted.add(key);
			let cached = this.cache.get(key);
			if (!cached) { cached = { signature: "", component: create() }; this.cache.set(key, cached); }
			if (cached.signature !== signature) { update?.(cached.component); cached.signature = signature; }
			this.root.addChild(cached.component);
		};
		const addTool = (id: string, name: string, args: unknown, argsComplete: boolean) => {
			if (seenTools.has(id)) return;
			seenTools.add(id);
			const result = results.get(id);
			const signature = JSON.stringify([name, args, argsComplete, result]);
			add(`tool:${id}`, signature,
				() => new Pi.ToolExecutionComponent(name, id, args ?? {}, { showImages: false }, toolDefinition(name, cwd), this.ui, cwd),
				(component) => {
					const tool = component as Pi.ToolExecutionComponent;
					tool.updateArgs(args ?? {});
					if (argsComplete || result) tool.setArgsComplete();
					if (result) {
						tool.markExecutionStarted();
						tool.updateResult({ content: result.content as Array<{ type: string; text?: string }>, details: result.details, isError: result.isError === true }, result.isPartial === true);
					}
					tool.setExpanded(this.expanded);
				});
		};
		for (const item of items) {
			const m = item.message;
			if (m.role === "user") {
				const text = extractText(m);
				// UserMessageComponent has no update method; identity is normally immutable.
				const key = `user:${item.key}:${text}`;
				add(key, text, () => new Pi.UserMessageComponent(text));
			} else if (m.role === "assistant") {
				const signature = JSON.stringify([m, item.streaming]);
				add(`assistant:${item.key}`, signature,
					() => new Pi.AssistantMessageComponent(undefined, this.hideThinking),
					(component) => (component as Pi.AssistantMessageComponent).updateContent(m as unknown as AssistantMessage, item.streaming));
				for (const block of m.content) if (block.type === "toolCall" && block.id) {
					addTool(String(block.id), String(block.name ?? "Tool"), record(block.arguments), !item.streaming);
				}
			} else if (m.role === "toolResult") {
				addTool(String(m.toolCallId ?? item.key), String(m.toolName ?? "Tool"), record(m.arguments), true);
			} else {
				const text = extractText(m);
				add(`custom:${item.key}:${text}`, text, () => new Markdown(text, 1, 0, Pi.getMarkdownTheme()));
			}
		}
		for (const [key, cached] of this.cache) if (!wanted.has(key)) {
			(cached.component as Component & { dispose?: () => void }).dispose?.(); this.cache.delete(key);
		}
		return this.root.render(Math.max(4, width));
	}
}
