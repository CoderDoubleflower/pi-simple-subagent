import { resolveProfileName } from "./guidance.ts";
import type { SubagentConfig } from "./types.ts";

export interface ModelSelection {
	model?: string;
	source: "profile" | "config" | "request" | "parent" | "child-default";
	ignoredOverride?: string;
}
function concrete(value: string | undefined): string | undefined {
	const model = value?.trim();
	return model && model !== "inherit" ? model : undefined;
}

/** Model-authored arguments cannot override an explicit user model configuration. */
export function selectDispatchModel(config: SubagentConfig, profileName: string | undefined, requested?: string, parent?: string): ModelSelection {
	const profile = config.profiles[resolveProfileName(profileName, config)];
	const profileModel = concrete(profile.model);
	const rootModel = concrete(config.model);
	const override = concrete(requested);
	const inherited = concrete(parent);
	const model = profileModel ?? rootModel ?? override ?? inherited;
	return {
		model,
		source: profileModel ? "profile" : rootModel ? "config" : override ? "request" : inherited ? "parent" : "child-default",
		...(override && (profileModel || rootModel) && override !== model ? { ignoredOverride: override } : {}),
	};
}
