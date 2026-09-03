import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type { ThinkingLevel };

export type InheritableModel = "inherit" | string;
export type ToolSelection = "inherit" | "none" | string[];
export type ResolvedToolSelection = "none" | string[];
export type AgentStatus = "starting" | "running" | "completed" | "errored" | "interrupted" | "closed";
export type ActivityStatus = "running" | "completed" | "errored";

export interface QuickSettings {
	model: InheritableModel;
	effort: ThinkingLevel | "inherit";
	tools: ToolSelection;
}

export interface AgentProfile {
	description?: string;
	systemPrompt?: string;
	model?: InheritableModel;
	effort?: ThinkingLevel | "inherit";
	tools?: ToolSelection;
	cwd?: string;
	extraArgs?: string[];
	env?: Record<string, string>;
}

export interface OutputConfig {
	maxFinalBytes: number;
	maxStderrBytes: number;
	maxActivityItems: number;
}

export interface ProcessConfig {
	command: string;
	extraArgs: string[];
	env: Record<string, string>;
	inheritEnvironment: boolean;
	excludeTools: string[];
	approveProject: "inherit" | "always" | "never";
}

export interface SubagentConfig extends QuickSettings {
	version: 1;
	defaultProfile: string;
	maxAgents: number;
	rpcStartupTimeoutMs: number;
	defaultWaitTimeoutMs: number;
	maxWaitTimeoutMs: number;
	killGraceMs: number;
	killForceMs: number;
	output: OutputConfig;
	process: ProcessConfig;
	profiles: Record<string, AgentProfile>;
}

export type ConfigScope = "user" | "project" | "explicit";

export interface ConfigDiagnostic {
	path: string;
	message: string;
	severity: "warning" | "error";
}

export interface LoadedConfig {
	config: SubagentConfig;
	userPath: string;
	projectPath: string;
	explicitPath?: string;
	diagnostics: ConfigDiagnostic[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentActivity {
	id: string;
	kind: "tool" | "message" | "system";
	name: string;
	summary: string;
	status: ActivityStatus;
	startedAt: number;
	endedAt?: number;
}

export interface ResolvedAgentSettings {
	profileName: string;
	profileDescription?: string;
	systemPrompt: string;
	model?: string;
	effort?: ThinkingLevel;
	tools: ResolvedToolSelection;
	cwd: string;
	extraArgs: string[];
	env: Record<string, string>;
	approveProject: boolean;
}

export interface AgentSnapshot {
	id: string;
	taskName: string;
	profileName: string;
	profileDescription?: string;
	message: string;
	status: AgentStatus;
	finalOutput: string;
	stderr: string;
	error?: string;
	model?: string;
	effort?: ThinkingLevel;
	tools: ResolvedToolSelection;
	cwd: string;
	usage: UsageStats;
	activities: AgentActivity[];
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface SpawnAgentRequest {
	taskName: string;
	message: string;
	profileName?: string;
	model?: string;
	effort?: ThinkingLevel;
	tools?: string[] | "none";
	cwd?: string;
}

export interface ParentDispatchDefaults {
	cwd: string;
	model?: string;
	effort?: ThinkingLevel;
	tools: string[];
	projectTrusted: boolean;
}

export interface WaitResult {
	status: Record<string, AgentSnapshot | { status: "not_found" }>;
	timedOut: boolean;
}

export interface CloseResult {
	previousSnapshot: AgentSnapshot | { status: "not_found" };
	snapshot?: AgentSnapshot;
}

export const AGENT_TOOL_DETAILS_KIND = "pi-simple-subagent" as const;

export interface AgentToolDetails {
	kind: typeof AGENT_TOOL_DETAILS_KIND;
	version: 1;
	action: "spawn" | "send" | "wait" | "close" | "list";
	snapshots: AgentSnapshot[];
	timedOut?: boolean;
	message?: string;
	previousSnapshot?: AgentSnapshot;
}

export type AgentToolDetailsPayload = Omit<AgentToolDetails, "kind" | "version">;

export function createAgentToolDetails(details: AgentToolDetailsPayload): AgentToolDetails {
	return { kind: AGENT_TOOL_DETAILS_KIND, version: 1, ...details };
}

export type AgentWireStatus =
	| "starting"
	| "running"
	| "interrupted"
	| "shutdown"
	| "not_found"
	| { completed: string }
	| { errored: string };
