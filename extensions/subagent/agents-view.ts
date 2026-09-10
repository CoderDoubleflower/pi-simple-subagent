import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Text, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentConversation, type SendPrompt } from "./agent-conversation.ts";
import type { AgentManager } from "./agent-manager.ts";
import { safeLine } from "./inline-rendering.ts";

export class AgentsView {
	readonly conversation: AgentConversation;
	private readonly editor: Editor;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	private readonly drafts = new Map<string, string>();
	private index = 0;
	private scroll = 0;
	private steer = false;
	private disposed = false;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private focus = true;
	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, manager: AgentManager, send: SendPrompt, done: () => void) {
		this.tui = tui; this.theme = theme; this.keys = keys; this.done = done;
		this.conversation = new AgentConversation(manager, send, () => this.requestRender());
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: { selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("dim", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("dim", text) },
		});
		this.editor.onSubmit = (text) => {
			const target = this.conversation.selected;
			void this.conversation.send(text, this.steer).catch((error) => {
				if (this.disposed || this.conversation.selected !== target) return;
				this.conversation.info = error instanceof Error ? error.message : String(error);
				if (!this.editor.getText()) this.editor.setText(text);
				this.requestRender();
			});
		};
	}
	get focused(): boolean { return this.focus; }
	set focused(value: boolean) { this.focus = value; this.editor.focused = value && !!this.conversation.selected; }
	async enter(target: string): Promise<void> {
		this.saveDraft(); this.editor.setText(""); this.scroll = 0; this.steer = false;
		const pending = this.conversation.select(target);
		const id = this.conversation.selected;
		if (id) this.editor.setText(this.drafts.get(id) ?? "");
		this.editor.focused = this.focus && !!id;
		await pending;
	}
	private saveDraft(): void { if (this.conversation.selected) this.drafts.set(this.conversation.selected, this.editor.getText()); }
	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "ctrl+g") || matchesKey(data, "ctrl+c")) { this.done(); return; }
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.conversation.selected) { this.saveDraft(); this.conversation.leave(); this.editor.setText(""); this.editor.focused = false; this.scroll = 0; this.requestRender(); }
			else this.done();
			return;
		}
		if (!this.conversation.selected) {
			const agents = this.conversation.list();
			if (this.keys.matches(data, "tui.select.up")) this.index = Math.max(0, this.index - 1);
			else if (this.keys.matches(data, "tui.select.down")) this.index = Math.min(Math.max(0, agents.length - 1), this.index + 1);
			else if (this.keys.matches(data, "tui.select.confirm") && agents[this.index]) void this.enter(agents[this.index].id);
			this.requestRender(); return;
		}
		if (matchesKey(data, "pageUp")) { this.scroll += 8; this.requestRender(); return; }
		if (matchesKey(data, "pageDown")) { this.scroll = Math.max(0, this.scroll - 8); this.requestRender(); return; }
		if (this.keys.matches(data, "tui.input.tab")) { this.steer = !this.steer; this.requestRender(); return; }
		this.editor.handleInput(data); this.requestRender();
	}
	render(width: number): string[] {
		if (this.disposed || width <= 0) return [];
		const height = Math.max(3, this.tui.terminal.rows);
		const t = this.theme;
		const lines: string[] = [t.fg("accent", t.bold("Agents")) + t.fg("dim", " · Parent tools paused")];
		const selected = this.conversation.snapshot;
		if (!this.conversation.selected) {
			lines.push(t.fg("dim", "Enter a live child context. Leaving this view does not stop the agent."), "");
			const agents = this.conversation.list();
			this.index = Math.min(this.index, Math.max(0, agents.length - 1));
			const start = Math.max(0, this.index - Math.max(1, height - 7));
			for (let i = start; i < Math.min(agents.length, start + Math.max(1, height - 5)); i++) {
				const agent = agents[i];
				lines.push(t.fg(i === this.index ? "accent" : "text", `${i === this.index ? "›" : " "} ${safeLine(agent.taskName, 64)} · ${safeLine(agent.profileName, 48)} · ${agent.status} · ${safeLine(agent.model, 120)}`));
			}
			if (!agents.length) lines.push(t.fg("dim", "No active agents. Spawn an agent first."));
			while (lines.length < height - 1) lines.push("");
			lines.push(t.fg("dim", "↑/↓ Select · Enter Open · Esc Return to parent"));
		} else {
			lines.push(t.fg("text", `${safeLine(selected?.taskName ?? this.conversation.selected, 64)} · ${selected?.status ?? "closed"} · ${safeLine(selected?.model, 120)}`));
			lines.push(t.fg("dim", safeLine(this.conversation.info, 240)));
			const editorLines = this.editor.render(width);
			const budget = Math.max(0, height - lines.length - editorLines.length - 2);
			const body: string[] = [];
			for (const message of this.conversation.mirror.messages) {
				body.push(t.fg("accent", message.role));
				body.push(...new Text(message.text, 0, 0).render(width), "");
			}
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - budget));
			const end = Math.max(0, body.length - this.scroll);
			const viewport = body.slice(Math.max(0, end - budget), end);
			while (viewport.length < budget) viewport.unshift("");
			lines.push(...viewport, t.fg("dim", this.steer ? "Send mode: Steer current work" : "Send mode: Queue follow-up (or start next turn)"), ...editorLines);
			lines.push(t.fg("dim", "Enter Send · Shift+Enter Newline · Tab Mode · PgUp/PgDn Scroll · Esc Back · Ctrl+G Parent"));
		}
		return lines.slice(0, height).map((line) => {
			const clipped = truncateToWidth(line, width); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		});
	}
	invalidate(): void { this.editor.invalidate(); }
	private requestRender(): void {
		if (this.disposed || this.renderTimer) return;
		this.renderTimer = setTimeout(() => { this.renderTimer = undefined; if (!this.disposed) this.tui.requestRender(); }, 50);
	}
	dispose(): void {
		if (this.disposed) return; this.disposed = true; clearTimeout(this.renderTimer); this.conversation.dispose();
	}
}

export async function showAgentsView(ctx: ExtensionContext, manager: AgentManager, send: SendPrompt, target: string, signal: AbortSignal): Promise<void> {
	if (ctx.mode !== "tui") { ctx.ui.notify("/agents requires an interactive TUI.", "warning"); return; }
	let view: AgentsView | undefined;
	let close: (() => void) | undefined;
	const onAbort = () => close?.();
	try {
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			close = () => { view?.dispose(); done(undefined); };
			view = new AgentsView(tui, theme, keys, manager, send, close);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) queueMicrotask(onAbort);
			else if (target.trim()) void view.enter(target.trim());
			return view;
		}, { overlay: true, overlayOptions: { width: "100%", anchor: "top-left", margin: 0 } });
	} finally { signal.removeEventListener("abort", onAbort); view?.dispose(); await view?.conversation.settleInput(); }
}
