// A2 Model provider adapter — config-driven task-class resolution.
// The orchestrator asks for a task CLASS, never a provider; swapping providers
// or adding hosted/RunPod models is a config change, not a code change.

import type { ModelProviderAdapter } from "./contracts.ts";
import type { AgentRole, ModelRef, TaskClass } from "../types.ts";

export interface ProviderConfig {
	readonly plan: ModelRef;
	readonly design: ModelRef;
	readonly build: ModelRef;
	readonly verify: ModelRef;
	/** Optional per-role overrides, e.g. frontend-dev → a different model. */
	readonly roleOverrides?: Partial<Record<AgentRole, ModelRef>>;
}

export class ConfigModelProvider implements ModelProviderAdapter {
	constructor(private readonly config: ProviderConfig) {}

	resolve(taskClass: TaskClass, role: AgentRole): ModelRef {
		const override = this.config.roleOverrides?.[role];
		if (override) return override;
		return this.config[taskClass];
	}
}

/** Default mapping — mirrors what cli-ts already supports today. */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
	plan: { provider: "anthropic-subscription", model: "default" },
	design: { provider: "anthropic-subscription", model: "default" },
	build: { provider: "anthropic-subscription", model: "default" },
	verify: { provider: "anthropic-subscription", model: "default" },
};
