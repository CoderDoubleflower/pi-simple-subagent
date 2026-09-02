import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentProfile,
	ConfigDiagnostic,
	ConfigScope,
	LoadedConfig,
	QuickSettings,
	SubagentConfig,
	ThinkingLevel,
	ToolSelection,
} from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const ORCHESTRATION_TOOLS = ["spawn_agent", "send_input", "wait_agent", "close_agent", "list_agents", "subagent"] as const;

export const DEFAULT_CONFIG: SubagentConfig = {
	version: 1,
	defaultProfile: "default",
	model: "inherit",
	effort: "inherit",
	tools: "inherit",
	maxAgents: 4,
	rpcStartupTimeoutMs: 15_000,
	defaultWaitTimeoutMs: 10_000,
	maxWaitTimeoutMs: 120_000,
	killGraceMs: 1_500,
	killForceMs: 3_000,
	output: {
		maxFinalBytes: 48 * 1024,
		maxStderrBytes: 16 * 1024,
		maxActivityItems: 200,
		collapsedActivityItems: 3,
		showToolActivity: true,
		showUsage: true,
		showElapsed: true,
		showExpandHint: true,
	},
	process: {
		command: "pi",
		extraArgs: [],
		env: {},
		inheritEnvironment: true,
		excludeTools: [...ORCHESTRATION_TOOLS],
		approveProject: "inherit",
	},
	profiles: {
		default: {
			description: "General-purpose subagent for a concrete, bounded task.",
		},
		explorer: {
			description: "Read-only codebase exploration and evidence gathering.",
			systemPrompt:
				"You are an exploration subagent. Inspect and reason about the codebase, cite concrete file paths and symbols, and report findings. Do not modify files.",
			tools: ["read", "grep", "find", "ls"],
		},
		worker: {
			description: "Implementation worker for a clearly bounded write scope.",
			systemPrompt:
				"You are an implementation subagent. Make only the requested changes, keep the write scope bounded, run relevant checks, and list every changed file in the final response.",
		},
		reviewer: {
			description: "Correctness, regression, security, and test review.",
			systemPrompt:
				"You are a review subagent. Prioritize concrete correctness defects, regressions, security risks, and missing tests. Report findings in severity order with file and line references. Do not modify files unless explicitly asked.",
			tools: ["read", "grep", "find", "ls"],
		},
	},
};

export interface LoadConfigOptions {
	cwd: string;
	projectTrusted: boolean;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		if (isRecord(value) && isRecord(result[key])) result[key] = mergeRecords(result[key] as Record<string, unknown>, value);
		else result[key] = value;
	}
	return result;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))];
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeTools(value: unknown, fallback: ToolSelection): ToolSelection {
	if (value === "inherit" || value === "none") return value;
	if (Array.isArray(value)) return stringArray(value, []);
	return Array.isArray(fallback) ? [...fallback] : fallback;
}

function normalizeModel(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeEffort(value: unknown, fallback: ThinkingLevel | "inherit"): ThinkingLevel | "inherit" {
	if (value === "inherit") return value;
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;
}

function normalizeProfile(value: unknown): AgentProfile {
	if (!isRecord(value)) return {};
	const profile: AgentProfile = {};
	if (typeof value.description === "string") profile.description = value.description;
	if (typeof value.systemPrompt === "string") profile.systemPrompt = value.systemPrompt;
	if (typeof value.model === "string" && value.model.trim()) profile.model = value.model.trim();
	if (value.effort === "inherit" || (typeof value.effort === "string" && THINKING_LEVELS.has(value.effort as ThinkingLevel))) {
		profile.effort = value.effort as ThinkingLevel | "inherit";
	}
	if (value.tools === "inherit" || value.tools === "none" || Array.isArray(value.tools)) profile.tools = normalizeTools(value.tools, "inherit");
	if (typeof value.cwd === "string" && value.cwd.trim()) profile.cwd = value.cwd.trim();
	if (Array.isArray(value.extraArgs)) profile.extraArgs = stringList(value.extraArgs, []);
	if (isRecord(value.env)) {
		profile.env = Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	}
	return profile;
}

export function normalizeConfig(value: unknown): SubagentConfig {
	const raw = isRecord(value) ? value : {};
	const defaults = DEFAULT_CONFIG;
	const output = isRecord(raw.output) ? raw.output : {};
	const processConfig = isRecord(raw.process) ? raw.process : {};
	const rawProfiles = isRecord(raw.profiles) ? raw.profiles : {};
	const profiles: Record<string, AgentProfile> = {};
	for (const [name, profile] of Object.entries(rawProfiles)) {
		if (/^[a-zA-Z0-9_.-]+$/.test(name)) profiles[name] = normalizeProfile(profile);
	}
	for (const [name, profile] of Object.entries(defaults.profiles)) {
		profiles[name] = { ...profile, ...(profiles[name] ?? {}) };
	}

	return {
		version: 1,
		defaultProfile: stringValue(raw.defaultProfile, defaults.defaultProfile),
		model: normalizeModel(raw.model, defaults.model),
		effort: normalizeEffort(raw.effort, defaults.effort),
		tools: normalizeTools(raw.tools, defaults.tools),
		maxAgents: boundedInteger(raw.maxAgents, defaults.maxAgents, 1, 32),
		rpcStartupTimeoutMs: boundedInteger(raw.rpcStartupTimeoutMs, defaults.rpcStartupTimeoutMs, 1_000, 120_000),
		defaultWaitTimeoutMs: boundedInteger(raw.defaultWaitTimeoutMs, defaults.defaultWaitTimeoutMs, 100, 120_000),
		maxWaitTimeoutMs: boundedInteger(raw.maxWaitTimeoutMs, defaults.maxWaitTimeoutMs, 1_000, 600_000),
		killGraceMs: boundedInteger(raw.killGraceMs, defaults.killGraceMs, 100, 60_000),
		killForceMs: boundedInteger(raw.killForceMs, defaults.killForceMs, 100, 60_000),
		output: {
			maxFinalBytes: boundedInteger(output.maxFinalBytes, defaults.output.maxFinalBytes, 1_024, 10 * 1024 * 1024),
			maxStderrBytes: boundedInteger(output.maxStderrBytes, defaults.output.maxStderrBytes, 1_024, 1024 * 1024),
			maxActivityItems: boundedInteger(output.maxActivityItems, defaults.output.maxActivityItems, 10, 5_000),
			collapsedActivityItems: boundedInteger(output.collapsedActivityItems, defaults.output.collapsedActivityItems, 0, 20),
			showToolActivity: booleanValue(output.showToolActivity, defaults.output.showToolActivity),
			showUsage: booleanValue(output.showUsage, defaults.output.showUsage),
			showElapsed: booleanValue(output.showElapsed, defaults.output.showElapsed),
			showExpandHint: booleanValue(output.showExpandHint, defaults.output.showExpandHint),
		},
		process: {
			command: stringValue(processConfig.command, defaults.process.command),
			extraArgs: stringList(processConfig.extraArgs, defaults.process.extraArgs),
			env: isRecord(processConfig.env)
				? Object.fromEntries(Object.entries(processConfig.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
				: {},
			inheritEnvironment: booleanValue(processConfig.inheritEnvironment, defaults.process.inheritEnvironment),
			excludeTools: stringArray(processConfig.excludeTools, defaults.process.excludeTools),
			approveProject:
				processConfig.approveProject === "always" || processConfig.approveProject === "never" || processConfig.approveProject === "inherit"
					? processConfig.approveProject
					: defaults.process.approveProject,
		},
		profiles,
	};
}

async function readConfigFile(filePath: string, diagnostics: ConfigDiagnostic[]): Promise<Record<string, unknown>> {
	try {
		const text = await fs.promises.readFile(filePath, "utf8");
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) throw new Error("configuration root must be a JSON object");
		return value;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		diagnostics.push({
			path: filePath,
			message: error instanceof Error ? error.message : String(error),
			severity: "error",
		});
		return {};
	}
}

async function readWritableLayer(filePath: string): Promise<Record<string, unknown>> {
	try {
		const text = await fs.promises.readFile(filePath, "utf8");
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) throw new Error("configuration root must be a JSON object");
		return value;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot update ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(tempPath, filePath);
		try {
			await fs.promises.chmod(filePath, 0o600);
		} catch {
			// chmod is best-effort on platforms without POSIX permissions.
		}
	} finally {
		await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

export function getConfigPaths(cwd: string, homeDir = os.homedir()): { userPath: string; projectPath: string } {
	return {
		userPath: path.join(homeDir, ".pi", "agent", "pi-simple-subagent.json"),
		projectPath: path.join(cwd, ".pi", "pi-simple-subagent.json"),
	};
}


function getExplicitPath(options: LoadConfigOptions): string | undefined {
	const env = options.env ?? process.env;
	return env.PI_SIMPLE_SUBAGENT_CONFIG ? path.resolve(options.cwd, env.PI_SIMPLE_SUBAGENT_CONFIG) : undefined;
}

function getScopePath(scope: ConfigScope, options: LoadConfigOptions): string {
	const paths = getConfigPaths(options.cwd, options.homeDir);
	if (scope === "project") return paths.projectPath;
	if (scope === "explicit") {
		const explicitPath = getExplicitPath(options);
		if (!explicitPath) throw new Error("PI_SIMPLE_SUBAGENT_CONFIG is not set, so there is no explicit configuration file to update.");
		return explicitPath;
	}
	return paths.userPath;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
	const diagnostics: ConfigDiagnostic[] = [];
	const paths = getConfigPaths(options.cwd, options.homeDir);
	let merged: Record<string, unknown> = clone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
	merged = mergeRecords(merged, await readConfigFile(paths.userPath, diagnostics));

	if (options.projectTrusted) {
		merged = mergeRecords(merged, await readConfigFile(paths.projectPath, diagnostics));
	} else if (fs.existsSync(paths.projectPath)) {
		diagnostics.push({ path: paths.projectPath, message: "Ignored project configuration because this project is not trusted.", severity: "warning" });
	}

	const explicitPath = getExplicitPath(options);
	if (explicitPath) merged = mergeRecords(merged, await readConfigFile(explicitPath, diagnostics));

	return { config: normalizeConfig(merged), userPath: paths.userPath, projectPath: paths.projectPath, explicitPath, diagnostics };
}

/** Write a complete standalone configuration. Primarily useful for tests and generated examples. */
export async function saveConfig(config: SubagentConfig, scope: ConfigScope, options: LoadConfigOptions): Promise<string> {
	if (scope === "project" && !options.projectTrusted) throw new Error("Cannot write project configuration before the project is trusted.");
	const filePath = getScopePath(scope, options);
	await writeJsonAtomic(filePath, normalizeConfig(config) as unknown as Record<string, unknown>);
	return filePath;
}

/**
 * Patch only the three quick settings owned by the TUI. Advanced settings and
 * unknown editor metadata in the selected JSON layer are preserved verbatim.
 */
export async function saveQuickSettings(settings: QuickSettings, scope: ConfigScope, options: LoadConfigOptions): Promise<string> {
	if (scope === "project" && !options.projectTrusted) throw new Error("Cannot write project configuration before the project is trusted.");
	const filePath = getScopePath(scope, options);
	const current = await readWritableLayer(filePath);
	current.version = 1;
	current.model = normalizeModel(settings.model, DEFAULT_CONFIG.model);
	current.effort = normalizeEffort(settings.effort, DEFAULT_CONFIG.effort);
	current.tools = normalizeTools(settings.tools, DEFAULT_CONFIG.tools);
	await writeJsonAtomic(filePath, current);
	return filePath;
}

export function cloneConfig(config: SubagentConfig): SubagentConfig {
	return clone(config);
}

export function quickSettings(config: SubagentConfig): QuickSettings {
	return {
		model: config.model,
		effort: config.effort,
		tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
	};
}
