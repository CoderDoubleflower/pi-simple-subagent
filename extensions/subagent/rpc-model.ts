export type RpcRequest = (command: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export interface RpcModel { provider: string; id: string }
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function readRpcModel(value: unknown): RpcModel | undefined {
	const model = record(value);
	return typeof model.provider === "string" && model.provider && typeof model.id === "string" && model.id
		? { provider: model.provider, id: model.id } : undefined;
}
export function modelName(model: RpcModel): string { return `${model.provider}/${model.id}`; }

/** Select an exact model and verify the child before submitting any prompt. */
export async function verifyRpcModel(request: RpcRequest, expected?: string, effort?: string, signal?: AbortSignal): Promise<string> {
	let desired: RpcModel | undefined;
	if (expected) {
		const available = record(await request({ type: "get_available_models" }, signal));
		const models = Array.isArray(available.models) ? available.models.flatMap((value) => {
			const model = readRpcModel(value); return model ? [model] : [];
		}) : [];
		const qualified = models.filter((model) => modelName(model) === expected);
		const matches = qualified.length ? qualified : models.filter((model) => model.id === expected);
		if (matches.length !== 1) {
			throw new Error(matches.length ? `Ambiguous subagent model "${expected}". Configure an exact provider/model.`
				: `Configured subagent model "${expected}" is unavailable in the child model registry. Check its provider, model ID and credentials; no parent-model fallback was used.`);
		}
		desired = matches[0];
		await request({ type: "set_model", provider: desired.provider, modelId: desired.id }, signal);
	}
	// Model switching can reset thinking level. Apply it after selecting the model.
	if (effort) await request({ type: "set_thinking_level", level: effort }, signal);
	const state = record(await request({ type: "get_state" }, signal));
	const actual = readRpcModel(state.model);
	if (!actual) throw new Error("Child RPC did not report an active model. The task was not submitted.");
	if (desired && modelName(actual) !== modelName(desired)) {
		throw new Error(`Subagent model mismatch: requested ${modelName(desired)}, child reports ${modelName(actual)}. The task was not submitted.`);
	}
	return modelName(actual);
}
