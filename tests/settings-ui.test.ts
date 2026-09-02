import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/subagent/config.ts";
import { showUnifiedSubagentSettings, UnifiedSubagentSettings } from "../extensions/subagent/settings-ui.ts";
import type { SettingsResult } from "../extensions/subagent/settings-ui.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagent-ui-test-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const keybindings = {
	matches: (data: string, action: string) =>
		({
			"tui.select.up": "up",
			"tui.select.down": "down",
			"tui.select.confirm": "enter",
			"tui.select.cancel": "escape",
		} as Record<string, string>)[action] === data,
} as unknown as KeybindingsManager;

describe("UnifiedSubagentSettings", () => {
	it("configures model, effort, tools, and save scope through one component", async () => {
		const home = tempDir();
		const cwd = tempDir();
		let resolveDone!: (value: SettingsResult | undefined) => void;
		const donePromise = new Promise<SettingsResult | undefined>((resolve) => {
			resolveDone = resolve;
		});
		const component = new UnifiedSubagentSettings({
			tui: { requestRender() {} } as unknown as TUI,
			theme,
			keybindings,
			initialConfig: DEFAULT_CONFIG,
			modelOptions: ["openai/gpt-test"],
			toolOptions: ["grep", "read"],
			projectTrusted: true,
			loadOptions: { cwd, homeDir: home, projectTrusted: true, env: {} },
			done: resolveDone,
		});

		assert.match(component.render(120).join("\n"), /Model.*Effort.*Tools/s);

		component.handleInput("enter"); // Model submenu
		component.handleInput("down");
		component.handleInput("enter"); // openai/gpt-test

		component.handleInput("down");
		component.handleInput("enter"); // Effort submenu
		for (let index = 0; index < 5; index++) component.handleInput("down"); // high
		component.handleInput("enter");

		component.handleInput("down");
		component.handleInput("down");
		component.handleInput("enter"); // Tools submenu
		component.handleInput("down");
		component.handleInput("down"); // grep
		component.handleInput(" ");
		component.handleInput("down"); // read
		component.handleInput(" ");
		component.handleInput("escape");

		component.handleInput("\t"); // project scope
		component.handleInput("s");
		const result = await donePromise;
		assert.ok(result);
		assert.equal(result.scope, "project");
		assert.equal(result.config.model, "openai/gpt-test");
		assert.equal(result.config.effort, "high");
		assert.deepEqual(result.config.tools, ["grep", "read"]);
		const saved = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "pi-simple-subagent.json"), "utf8"));
		assert.deepEqual(
			{ model: saved.model, effort: saved.effort, tools: saved.tools },
			{ model: "openai/gpt-test", effort: "high", tools: ["grep", "read"] },
		);
	});

	it("builds choices from Pi's model registry and tool registry while hiding orchestration tools", async () => {
		const cwd = tempDir();
		const seen: string[] = [];
		const pi = {
			getAllTools: () => [{ name: "read" }, { name: "spawn_agent" }, { name: "custom_search" }],
		};
		const ctx = {
			cwd,
			mode: "tui",
			model: { provider: "openai", id: "current" },
			scopedModels: [{ model: { provider: "openai", id: "scoped" } }],
			modelRegistry: { getAvailable: () => [{ provider: "openai", id: "registry" }] },
			isProjectTrusted: () => false,
			ui: {
				notify() {},
				custom: async (factory: Function) => {
					const component = factory({ requestRender() {} } as unknown as TUI, theme, keybindings, () => undefined) as UnifiedSubagentSettings;
					component.handleInput("enter");
					seen.push(component.render(120).join("\n"));
					component.handleInput("escape");
					component.handleInput("down");
					component.handleInput("down");
					component.handleInput("enter");
					seen.push(component.render(120).join("\n"));
					return undefined;
				},
			},
		};
		await showUnifiedSubagentSettings(pi as never, ctx as never, DEFAULT_CONFIG);
		assert.match(seen[0], /openai\/current/);
		assert.match(seen[0], /openai\/scoped/);
		assert.match(seen[0], /openai\/registry/);
		assert.match(seen[1], /read/);
		assert.match(seen[1], /custom_search/);
		assert.ok(!seen[1].includes("spawn_agent"));
	});
});
