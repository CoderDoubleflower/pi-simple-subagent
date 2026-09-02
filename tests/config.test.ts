import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig, saveQuickSettings } from "../extensions/subagent/config.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagent-test-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("configuration", () => {
	it("normalizes bounds and preserves built-in profiles", () => {
		const config = normalizeConfig({
			maxAgents: 999,
			effort: "high",
			tools: ["read", "read", "grep"],
			profiles: { custom: { model: "openai/test" } },
		});
		assert.equal(config.maxAgents, 32);
		assert.equal(config.effort, "high");
		assert.deepEqual(config.tools, ["read", "grep"]);
		assert.ok(config.profiles.default);
		assert.equal(config.profiles.custom.model, "openai/test");
	});

	it("preserves ordered and repeated CLI extra arguments while deduplicating tool names", () => {
		const config = normalizeConfig({
			process: { extraArgs: ["--append-system-prompt", "one.md", "--append-system-prompt", "two.md"] },
			profiles: { custom: { extraArgs: ["--flag", "same", "--flag", "same"] } },
			tools: ["read", "read", "grep"],
		});
		assert.deepEqual(config.process.extraArgs, ["--append-system-prompt", "one.md", "--append-system-prompt", "two.md"]);
		assert.deepEqual(config.profiles.custom.extraArgs, ["--flag", "same", "--flag", "same"]);
		assert.deepEqual(config.tools, ["read", "grep"]);
	});

	it("merges user, trusted project, and explicit config in order", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const userPath = path.join(home, ".pi", "agent", "pi-simple-subagent.json");
		const projectPath = path.join(cwd, ".pi", "pi-simple-subagent.json");
		const explicitPath = path.join(cwd, "explicit.json");
		fs.mkdirSync(path.dirname(userPath), { recursive: true });
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(userPath, JSON.stringify({ model: "openai/user", output: { showUsage: false } }));
		fs.writeFileSync(projectPath, JSON.stringify({ effort: "high", output: { showElapsed: false } }));
		fs.writeFileSync(explicitPath, JSON.stringify({ model: "openai/explicit" }));
		const loaded = await loadConfig({
			cwd,
			homeDir: home,
			projectTrusted: true,
			env: { PI_SIMPLE_SUBAGENT_CONFIG: explicitPath },
		});
		assert.equal(loaded.config.model, "openai/explicit");
		assert.equal(loaded.config.effort, "high");
		assert.equal(loaded.config.output.showUsage, false);
		assert.equal(loaded.config.output.showElapsed, false);
	});

	it("ignores project configuration when untrusted", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const projectPath = path.join(cwd, ".pi", "pi-simple-subagent.json");
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(projectPath, JSON.stringify({ model: "openai/project" }));
		const loaded = await loadConfig({ cwd, homeDir: home, projectTrusted: false, env: {} });
		assert.equal(loaded.config.model, DEFAULT_CONFIG.model);
		assert.ok(loaded.diagnostics.some((item) => item.message.includes("not trusted")));
	});

	it("writes normalized complete configuration atomically", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const filePath = await saveConfig({ ...DEFAULT_CONFIG, maxAgents: 7 }, "user", {
			cwd,
			homeDir: home,
			projectTrusted: true,
		});
		const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
		assert.equal(saved.maxAgents, 7);
		assert.equal(saved.output.showExpandHint, true);
	});

	it("patches only quick settings and preserves advanced and unknown fields", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const userPath = path.join(home, ".pi", "agent", "pi-simple-subagent.json");
		const projectPath = path.join(cwd, ".pi", "pi-simple-subagent.json");
		fs.mkdirSync(path.dirname(userPath), { recursive: true });
		fs.mkdirSync(path.dirname(projectPath), { recursive: true });
		fs.writeFileSync(
			userPath,
			JSON.stringify({
				$schema: "custom-schema.json",
				maxAgents: 9,
				process: { command: "custom-pi" },
				profiles: { custom: { systemPrompt: "keep me" } },
				editorMetadata: { folded: true },
			}),
		);
		fs.writeFileSync(projectPath, JSON.stringify({ output: { showElapsed: false } }));
		await saveQuickSettings({ model: "openai/new", effort: "high", tools: ["read", "grep"] }, "user", {
			cwd,
			homeDir: home,
			projectTrusted: true,
		});
		const saved = JSON.parse(fs.readFileSync(userPath, "utf8"));
		assert.equal(saved.$schema, "custom-schema.json");
		assert.equal(saved.maxAgents, 9);
		assert.deepEqual(saved.process, { command: "custom-pi" });
		assert.equal(saved.profiles.custom.systemPrompt, "keep me");
		assert.equal(saved.editorMetadata.folded, true);
		assert.equal(saved.model, "openai/new");
		assert.equal(saved.effort, "high");
		assert.deepEqual(saved.tools, ["read", "grep"]);
		assert.equal(saved.output, undefined, "project settings must not be copied into the user layer");
	});

	it("refuses project writes before project trust is granted", async () => {
		const home = tempDir();
		const cwd = tempDir();
		await assert.rejects(
			() =>
				saveQuickSettings({ model: "inherit", effort: "inherit", tools: "inherit" }, "project", {
					cwd,
					homeDir: home,
					projectTrusted: false,
				}),
			/not trusted|before the project is trusted/,
		);
	});

	it("patches the active explicit configuration layer", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const explicitPath = path.join(cwd, "selected.json");
		fs.writeFileSync(explicitPath, JSON.stringify({ maxAgents: 6, model: "old" }));
		await saveQuickSettings(
			{ model: "openai/explicit", effort: "low", tools: "none" },
			"explicit",
			{ cwd, homeDir: home, projectTrusted: false, env: { PI_SIMPLE_SUBAGENT_CONFIG: explicitPath } },
		);
		const saved = JSON.parse(fs.readFileSync(explicitPath, "utf8"));
		assert.equal(saved.maxAgents, 6);
		assert.equal(saved.model, "openai/explicit");
		assert.equal(saved.effort, "low");
		assert.equal(saved.tools, "none");
	});

	it("refuses to overwrite invalid JSON while patching quick settings", async () => {
		const home = tempDir();
		const cwd = tempDir();
		const userPath = path.join(home, ".pi", "agent", "pi-simple-subagent.json");
		fs.mkdirSync(path.dirname(userPath), { recursive: true });
		fs.writeFileSync(userPath, "{ invalid json");
		await assert.rejects(
			() => saveQuickSettings({ model: "inherit", effort: "inherit", tools: "inherit" }, "user", { cwd, homeDir: home, projectTrusted: true }),
			/Cannot update/,
		);
		assert.equal(fs.readFileSync(userPath, "utf8"), "{ invalid json");
	});
});
