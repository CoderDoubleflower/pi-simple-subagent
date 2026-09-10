import type { AgentSnapshot, AgentStatus } from "./types.ts";

export interface InlineAgent {
	id: string; taskName: string; profileName: string; status: AgentStatus;
	model?: string; startedAt: number; completedAt?: number; toolUses: number;
}
export function inlineAgent(s: AgentSnapshot): InlineAgent {
	return { id: s.id, taskName: s.taskName, profileName: s.profileName, status: s.status,
		model: s.model, startedAt: s.startedAt, completedAt: s.completedAt,
		toolUses: s.activities.filter((item) => item.kind === "tool").length };
}
const active = (status: AgentStatus) => status === "starting" || status === "running";

/** UI metadata only, never child messages, tool arguments, responses or logs. */
export class InlineAgentStore {
	private readonly agents = new Map<string, InlineAgent>();
	private readonly rows = new Map<string, { ids: string[]; invalidate(): void }>();
	private timer?: ReturnType<typeof setInterval>;
	private disposed = false;
	accept(snapshot: AgentSnapshot): void {
		if (this.disposed) return;
		this.agents.set(snapshot.id, inlineAgent(snapshot));
		for (const row of this.rows.values()) if (row.ids.includes(snapshot.id)) row.invalidate();
		this.updateTimer();
	}
	get(id: string): InlineAgent | undefined { return this.agents.get(id); }
	all(): InlineAgent[] { return [...this.agents.values()]; }
	watch(key: string, ids: string[], invalidate: () => void): void {
		if (this.disposed) return;
		this.rows.set(key, { ids, invalidate });
		if (this.rows.size > 512) this.rows.delete(this.rows.keys().next().value!);
		this.updateTimer();
	}
	dispose(): void {
		this.disposed = true; clearInterval(this.timer); this.timer = undefined;
		this.rows.clear(); this.agents.clear();
	}
	private updateTimer(): void {
		const hasRunning = [...this.rows.values()].some((row) => row.ids.some((id) => {
			const agent = this.agents.get(id); return agent && active(agent.status);
		}));
		if (!hasRunning) { clearInterval(this.timer); this.timer = undefined; return; }
		if (!this.timer) {
			this.timer = setInterval(() => {
				for (const row of this.rows.values()) if (row.ids.some((id) => {
					const agent = this.agents.get(id); return agent && active(agent.status);
				})) row.invalidate();
			}, 1000);
			this.timer.unref?.();
		}
	}
}
