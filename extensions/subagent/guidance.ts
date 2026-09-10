import type { SubagentConfig } from "./types.ts";

export function resolveProfileName(value: string | undefined, config: SubagentConfig): string {
	const name = value?.trim() || config.defaultProfile;
	if (!Object.hasOwn(config.profiles, name)) {
		throw new Error(`Unknown subagent profile "${name}". Available profiles: ${Object.keys(config.profiles).sort().join(", ") || "none"}.`);
	}
	return name;
}

/** Stable for an unchanged config; do not put timers or live status into the system prompt. */
export function delegationGuidance(config: SubagentConfig): string {
	const profiles = Object.entries(config.profiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, profile]) =>
		`- ${JSON.stringify(name)}: ${(profile.description || "Configured subagent profile.").replace(/\s+/g, " ").trim()}`,
	);
	return [
		"## Subagent delegation contract",
		`Available subagent profiles (agent_type); defaultProfile=${JSON.stringify(config.defaultProfile)}:`,
		...profiles,
		"Omit agent_type to use defaultProfile. Empty or whitespace-only agent_type also means defaultProfile. Never invent a profile name.",
		"Delegate only bounded, self-contained tasks that can proceed independently. Include the expected deliverable and necessary context in message; do not delegate the immediate critical-path action.",
		"A successfully delegated task belongs to that subagent until it finishes or you explicitly close it. Do not redo the same investigation, implement the same change, or write into its owned scope while it runs. Reading shared background is allowed; repeating its task is not.",
		"For implementation tasks, supply write_scope with exact files, directories, or trailing /** scopes. Assign disjoint write scopes. Scope checks cover explicit file-writing tools, not arbitrary shell scripts or external side effects.",
		"Continue only useful, non-overlapping work. When there is no independent work, call wait_agent once and let it wait. Do not repeatedly call list_agents, use short timeout polling, or take over work merely because a wait timed out.",
		"Completion is delivered automatically and invisibly to this conversation when not claimed by wait_agent. Each execution round is delivered once. list_agents is for diagnostics, not result collection. Already-delivered completions do not unblock waits for still-running agents.",
		"Use send_input to refine a task, and close_agent to cancel/release it before an explicit takeover. A follow-up retains the original write_scope; close and respawn for a different scope. Review and integrate the final result after completion; do not print child prompts, internal transcripts, or raw child output. Give the user your own integrated answer.",
	].join("\n");
}
