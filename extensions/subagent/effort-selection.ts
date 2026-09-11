import { resolveProfileName } from "./guidance.ts";
import type { SubagentConfig, ThinkingLevel } from "./types.ts";
import type { RpcRequest } from "./rpc-model.ts";

export interface EffortSelection {
	effort?: ThinkingLevel;
	source: "profile" | "config" | "request" | "parent" | "child-default";
	ignoredOverride?: ThinkingLevel;
}
export function selectDispatchEffort(config: SubagentConfig, profileName: string | undefined, requested?: ThinkingLevel, parent?: ThinkingLevel): EffortSelection {
	const profile = config.profiles[resolveProfileName(profileName, config)];
	const profileEffort = profile.effort === "inherit" ? undefined : profile.effort;
	const rootEffort = config.effort === "inherit" ? undefined : config.effort;
	const effort = profileEffort ?? rootEffort ?? requested ?? parent;
	return { effort, source: profileEffort !== undefined ? "profile" : rootEffort !== undefined ? "config" : requested !== undefined ? "request" : parent !== undefined ? "parent" : "child-default",
		...(requested !== undefined && (profileEffort !== undefined || rootEffort !== undefined) && requested !== effort ? { ignoredOverride: requested } : {}) };
}

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Read the effective value after model/thinking selection, including explicit off. */
export async function verifyRpcEffort(request: RpcRequest, expected?: ThinkingLevel, signal?: AbortSignal): Promise<ThinkingLevel> {
	const value = await request({ type: "get_state" }, signal);
	const actual = value && typeof value === "object" ? (value as { thinkingLevel?: unknown }).thinkingLevel : undefined;
	if (typeof actual !== "string" || !LEVELS.has(actual)) throw new Error("Child RPC did not report its thinking level. The task was not submitted.");
	if (expected !== undefined && actual !== expected) {
		throw new Error(`Subagent reasoning effort mismatch: requested ${expected}, child reports ${actual}. Check model-supported thinking levels and child extensions. The task was not submitted.`);
	}
	return actual as ThinkingLevel;
}
