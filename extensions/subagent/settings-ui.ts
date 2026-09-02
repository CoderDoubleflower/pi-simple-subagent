import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	ORCHESTRATION_TOOLS,
	loadConfig,
	quickSettings,
	saveQuickSettings,
	type LoadConfigOptions,
} from "./config.ts";
import type { ConfigScope, QuickSettings, SubagentConfig, ThinkingLevel, ToolSelection } from "./types.ts";

const EFFORTS: Array<ThinkingLevel | "inherit"> = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_VISIBLE_CHOICES = 12;

type View = "main" | "model" | "effort" | "tools" | "custom-model" | "custom-tool";

export interface SettingsResult {
	config: SubagentConfig;
	scope: ConfigScope;
	path: string;
}

interface SettingsComponentOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	initialConfig: SubagentConfig;
	modelOptions: string[];
	toolOptions: string[];
	projectTrusted: boolean;
	explicitPath?: string;
	loadOptions: LoadConfigOptions;
	done: (value: SettingsResult | undefined) => void;
}

function displayTools(tools: ToolSelection): string {
	if (tools === "inherit") return "inherit parent";
	if (tools === "none") return "none";
	return tools.length ? tools.join(", ") : "none";
}

function isEnter(data: string): boolean {
	return data === "\r" || data === "\n";
}

function isEscape(data: string): boolean {
	return data === "\u001b" || data === "\u0003";
}

function isBackspace(data: string): boolean {
	return data === "\u007f" || data === "\b";
}

function visibleRange(cursor: number, count: number): { start: number; end: number } {
	const visible = Math.min(MAX_VISIBLE_CHOICES, count);
	const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), count - visible));
	return { start, end: Math.min(count, start + visible) };
}

export class UnifiedSubagentSettings implements Component {
	private readonly options: SettingsComponentOptions;
	private quick: QuickSettings;
	private scope: ConfigScope = "user";
	private view: View = "main";
	private cursor = 0;
	private buffer = "";
	private toolDraft = new Set<string>();
	private saving = false;
	private message = "";

	constructor(options: SettingsComponentOptions) {
		this.options = options;
		this.quick = quickSettings(options.initialConfig);
		if (options.explicitPath) this.scope = "explicit";
	}

	handleInput(data: string): void {
		if (this.saving) return;
		if (this.view === "custom-model" || this.view === "custom-tool") {
			this.handleTextInput(data);
			return;
		}

		const keybindings = this.options.keybindings;
		if (isEscape(data) || keybindings.matches(data, "tui.select.cancel")) {
			if (this.view === "main") this.options.done(undefined);
			else this.openView("main");
			return;
		}

		const count = this.itemCount();
		if (keybindings.matches(data, "tui.select.up")) this.cursor = (this.cursor - 1 + count) % count;
		else if (keybindings.matches(data, "tui.select.down")) this.cursor = (this.cursor + 1) % count;
		else if (data === "\t" && this.view === "main") this.toggleScope();
		else if ((data === "s" || data === "S") && this.view === "main") void this.persist();
		else if ((data === "r" || data === "R") && this.view === "main") this.resetQuickSettings();
		else if (this.view === "tools" && data === " ") this.toggleCurrentTool();
		else if (isEnter(data) || keybindings.matches(data, "tui.select.confirm")) this.activate();
		this.options.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const lines: string[] = [];
		lines.push("");
		lines.push(
			truncateToWidth(
				theme.fg("accent", theme.bold(" Subagent configuration ")) +
					theme.fg("borderMuted", "─".repeat(Math.max(0, width - 28))),
				width,
			),
		);
		lines.push(theme.fg("dim", " Configure model, reasoning effort, and child tools in one interface."));
		lines.push("");

		if (this.view === "main") this.renderMain(lines, width);
		else if (this.view === "model") {
			this.renderChoice(lines, "Model", ["inherit", ...this.options.modelOptions, "Custom model…"], this.currentModelIndex());
		} else if (this.view === "effort") {
			this.renderChoice(lines, "Reasoning effort", EFFORTS, EFFORTS.indexOf(this.quick.effort));
		} else if (this.view === "tools") this.renderTools(lines);
		else this.renderTextEntry(lines, this.view === "custom-model" ? "Custom model (provider/model)" : "Custom tool name");

		lines.push("");
		if (this.message) lines.push(truncateToWidth(` ${theme.fg("warning", this.message)}`, width));
		const help =
			this.view === "main"
				? " ↑/↓ navigate · Enter edit · Tab scope · S save · R reset quick settings · Esc cancel"
				: this.view === "tools"
					? " ↑/↓ navigate · Space toggle · Enter select/done · Esc back"
					: this.view === "custom-model" || this.view === "custom-tool"
						? " Type value · Enter accept · Esc back"
						: " ↑/↓ navigate · Enter select · Esc back";
		lines.push(truncateToWidth(theme.fg("dim", help), width));
		lines.push("");
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// Rendering is derived directly from current state; no cache to clear.
	}

	private renderMain(lines: string[], width: number): void {
		const theme = this.options.theme;
		const rows = [
			["Model", this.quick.model],
			["Effort", this.quick.effort],
			["Tools", displayTools(this.quick.tools)],
			["Save scope", this.scopeLabel()],
			["Save", "Patch quick settings and close"],
			["Reset", "Set model, effort, and tools to inherit"],
			["Cancel", "Discard unsaved changes"],
		] as const;
		for (let index = 0; index < rows.length; index++) {
			const [label, value] = rows[index];
			const selected = index === this.cursor;
			const prefix = selected ? theme.fg("accent", "❯ ") : "  ";
			const left = selected ? theme.fg("toolTitle", theme.bold(label.padEnd(12))) : theme.fg("text", label.padEnd(12));
			const right = theme.fg(index === 4 ? "success" : index === 6 ? "dim" : "muted", value);
			lines.push(truncateToWidth(`${prefix}${left}${right}`, width));
		}
		lines.push("");
		const profiles = Object.keys(this.options.initialConfig.profiles).join(", ");
		lines.push(truncateToWidth(theme.fg("dim", ` Config profiles: ${profiles}`), width));
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					" Advanced limits, process, output, environment, and profile settings are preserved in the JSON file.",
				),
				width,
			),
		);
	}

	private renderChoice(lines: string[], title: string, choices: readonly string[], activeIndex: number): void {
		const theme = this.options.theme;
		lines.push(theme.fg("toolTitle", theme.bold(` ${title}`)));
		lines.push("");
		const { start, end } = visibleRange(this.cursor, choices.length);
		for (let index = start; index < end; index++) {
			const selected = index === this.cursor;
			const active = index === activeIndex;
			lines.push(
				`${selected ? theme.fg("accent", "❯ ") : "  "}${active ? theme.fg("success", "● ") : theme.fg("dim", "○ ")}${
					selected ? theme.fg("toolTitle", choices[index]) : theme.fg("text", choices[index])
				}`,
			);
		}
		if (start > 0 || end < choices.length) lines.push(theme.fg("dim", `  (${this.cursor + 1}/${choices.length})`));
	}

	private renderTools(lines: string[]): void {
		const theme = this.options.theme;
		const choices = this.toolChoices();
		lines.push(theme.fg("toolTitle", theme.bold(" Child tools")));
		lines.push(theme.fg("dim", " Select an explicit allowlist, or inherit the parent tool set."));
		lines.push("");
		const { start, end } = visibleRange(this.cursor, choices.length);
		for (let index = start; index < end; index++) {
			const choice = choices[index];
			const selected = index === this.cursor;
			let checked = false;
			if (choice.kind === "inherit") checked = this.quick.tools === "inherit";
			else if (choice.kind === "none") checked = this.quick.tools === "none";
			else if (choice.kind === "tool") checked = this.toolDraft.has(choice.value);
			const marker =
				choice.kind === "done" || choice.kind === "add"
					? "  "
					: checked
						? theme.fg("success", "✓ ")
						: theme.fg("dim", "○ ");
			lines.push(
				`${selected ? theme.fg("accent", "❯ ") : "  "}${marker}${
					selected ? theme.fg("toolTitle", choice.label) : theme.fg("text", choice.label)
				}`,
			);
		}
		if (start > 0 || end < choices.length) lines.push(theme.fg("dim", `  (${this.cursor + 1}/${choices.length})`));
	}

	private renderTextEntry(lines: string[], title: string): void {
		const theme = this.options.theme;
		lines.push(theme.fg("toolTitle", theme.bold(` ${title}`)));
		lines.push("");
		lines.push(` ${theme.fg("accent", "> ")}${this.buffer}${theme.fg("accent", "▌")}`);
	}

	private itemCount(): number {
		if (this.view === "main") return 7;
		if (this.view === "model") return 2 + this.options.modelOptions.length;
		if (this.view === "effort") return EFFORTS.length;
		if (this.view === "tools") return this.toolChoices().length;
		return 1;
	}

	private activate(): void {
		if (this.view === "main") {
			switch (this.cursor) {
				case 0:
					this.openView("model", this.currentModelIndex());
					break;
				case 1:
					this.openView("effort", Math.max(0, EFFORTS.indexOf(this.quick.effort)));
					break;
				case 2:
					this.toolDraft = new Set(Array.isArray(this.quick.tools) ? this.quick.tools : []);
					this.openView("tools");
					break;
				case 3:
					this.toggleScope();
					break;
				case 4:
					void this.persist();
					break;
				case 5:
					this.resetQuickSettings();
					break;
				case 6:
					this.options.done(undefined);
					break;
			}
			return;
		}
		if (this.view === "model") {
			const choices = ["inherit", ...this.options.modelOptions, "Custom model…"];
			const choice = choices[this.cursor];
			if (choice === "Custom model…") {
				this.buffer = this.quick.model === "inherit" ? "" : this.quick.model;
				this.openView("custom-model");
			} else {
				this.quick.model = choice;
				this.openView("main");
			}
			return;
		}
		if (this.view === "effort") {
			this.quick.effort = EFFORTS[this.cursor];
			this.openView("main");
			return;
		}
		if (this.view === "tools") {
			const choice = this.toolChoices()[this.cursor];
			if (choice.kind === "inherit") {
				this.quick.tools = "inherit";
				this.toolDraft.clear();
			} else if (choice.kind === "none") {
				this.quick.tools = "none";
				this.toolDraft.clear();
			} else if (choice.kind === "tool") this.toggleCurrentTool();
			else if (choice.kind === "add") {
				this.buffer = "";
				this.openView("custom-tool");
			} else {
				if (this.quick.tools !== "inherit") this.quick.tools = this.toolDraft.size > 0 ? [...this.toolDraft].sort() : "none";
				this.openView("main");
			}
		}
	}

	private toggleCurrentTool(): void {
		const choice = this.toolChoices()[this.cursor];
		if (choice?.kind !== "tool") return;
		if (this.quick.tools === "inherit" || this.quick.tools === "none") this.quick.tools = [];
		if (this.toolDraft.has(choice.value)) this.toolDraft.delete(choice.value);
		else this.toolDraft.add(choice.value);
		this.quick.tools = this.toolDraft.size > 0 ? [...this.toolDraft].sort() : "none";
	}

	private toolChoices(): Array<
		| { kind: "inherit" | "none" | "add" | "done"; label: string }
		| { kind: "tool"; label: string; value: string }
	> {
		const tools = [...new Set([...this.options.toolOptions, ...this.toolDraft])].sort();
		return [
			{ kind: "inherit", label: "Inherit parent tools" },
			{ kind: "none", label: "No tools" },
			...tools.map((tool) => ({ kind: "tool" as const, label: tool, value: tool })),
			{ kind: "add", label: "Add custom tool…" },
			{ kind: "done", label: "Done" },
		];
	}

	private handleTextInput(data: string): void {
		if (isEscape(data) || this.options.keybindings.matches(data, "tui.select.cancel")) {
			this.openView(this.view === "custom-model" ? "model" : "tools");
			return;
		}
		if (isEnter(data) || this.options.keybindings.matches(data, "tui.select.confirm")) {
			const value = this.buffer.trim();
			if (!value) {
				this.message = "A non-empty value is required.";
				this.options.tui.requestRender();
				return;
			}
			if (this.view === "custom-model") {
				this.quick.model = value;
				this.openView("main");
			} else {
				this.toolDraft.add(value);
				this.quick.tools = [...this.toolDraft].sort();
				this.openView("tools");
			}
			return;
		}
		if (isBackspace(data)) this.buffer = this.buffer.slice(0, -1);
		else if (!data.startsWith("\u001b") && data >= " ") this.buffer += data;
		this.options.tui.requestRender();
	}

	private currentModelIndex(): number {
		if (this.quick.model === "inherit") return 0;
		const index = this.options.modelOptions.indexOf(this.quick.model);
		return index >= 0 ? index + 1 : this.options.modelOptions.length + 1;
	}

	private availableScopes(): ConfigScope[] {
		const scopes: ConfigScope[] = ["user"];
		if (this.options.projectTrusted) scopes.push("project");
		if (this.options.explicitPath) scopes.push("explicit");
		return scopes;
	}

	private scopeLabel(): string {
		if (this.scope === "project") return "Project (.pi)";
		if (this.scope === "explicit") return `Explicit (${this.options.explicitPath})`;
		return "User (~/.pi/agent)";
	}

	private toggleScope(): void {
		const scopes = this.availableScopes();
		const index = scopes.indexOf(this.scope);
		this.scope = scopes[(index + 1) % scopes.length];
		this.message = scopes.length === 1 ? "Only user scope is writable until the project is trusted." : "";
	}

	private resetQuickSettings(): void {
		this.quick = quickSettings(DEFAULT_CONFIG);
		this.toolDraft.clear();
		this.message = "Model, effort, and tools reset to inherit; press S to save.";
	}

	private openView(view: View, cursor = 0): void {
		this.view = view;
		this.cursor = Math.max(0, Math.min(cursor, this.itemCount() - 1));
		this.message = "";
		this.options.tui.requestRender();
	}

	private async persist(): Promise<void> {
		this.saving = true;
		this.message = "Saving…";
		this.options.tui.requestRender();
		try {
			const path = await saveQuickSettings(this.quick, this.scope, this.options.loadOptions);
			const loaded = await loadConfig(this.options.loadOptions);
			if (loaded.diagnostics.some((item) => item.severity === "error")) {
				throw new Error(loaded.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; "));
			}
			const result = { config: loaded.config, scope: this.scope, path };
			this.options.done(result);
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
			this.saving = false;
			this.options.tui.requestRender();
		}
	}
}

export async function showUnifiedSubagentSettings(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: SubagentConfig,
): Promise<SettingsResult | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/subagent-config requires TUI mode.", "warning");
		return undefined;
	}

	let registryModels: Array<{ provider: string; id: string }> = [];
	try {
		registryModels = ctx.modelRegistry.getAvailable();
	} catch {
		// Fall back to the current/scoped models if the registry is refreshing.
	}
	const modelOptions = [
		...(ctx.model ? [`${ctx.model.provider}/${ctx.model.id}`] : []),
		...ctx.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`),
		...registryModels.map((model) => `${model.provider}/${model.id}`),
	]
		.filter((value, index, values) => values.indexOf(value) === index)
		.sort((left, right) => left.localeCompare(right));

	const orchestration = new Set<string>([...ORCHESTRATION_TOOLS, ...config.process.excludeTools]);
	const toolOptions = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name, index, values) => !orchestration.has(name) && values.indexOf(name) === index)
		.sort((left, right) => left.localeCompare(right));

	const projectTrusted = ctx.isProjectTrusted();
	const loadOptions: LoadConfigOptions = { cwd: ctx.cwd, projectTrusted };
	const locations = await loadConfig(loadOptions);
	return ctx.ui.custom<SettingsResult | undefined>((tui, theme, keybindings, done) =>
		new UnifiedSubagentSettings({
			tui,
			theme,
			keybindings,
			initialConfig: config,
			modelOptions,
			toolOptions,
			projectTrusted,
			explicitPath: locations.explicitPath,
			loadOptions,
			done,
		}),
	);
}
