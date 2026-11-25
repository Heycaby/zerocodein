// A5 Execution adapter — local dispatch via A1; cloud path declared, unimplemented.

import type {
	AgentRuntimeAdapter,
	ExecutionAdapter,
	ExecutionEnv,
	SessionHandle,
	SessionSpec,
} from "./contracts.ts";

export class ExecutionAdapterImpl implements ExecutionAdapter {
	constructor(private readonly runtime: AgentRuntimeAdapter) {}

	async dispatch(spec: SessionSpec, env: ExecutionEnv): Promise<SessionHandle> {
		if (env === "cloud") {
			throw new Error("cloud execution not yet implemented — local only in Phase 1");
		}
		return this.runtime.startSession(spec);
	}
}
