// A1 Agent runtime adapter — two implementations:
//   CliTsRuntime: drives the vendored cli-ts in --print NDJSON mode.
//   FakeRuntime: deterministic stub for tests (no model calls).

import type {
	AgentRuntimeAdapter,
	RuntimeEvent,
	SessionHandle,
	SessionSpec,
} from "./contracts.ts";

const CLI_TS_ENTRY =
	"/Users/heycaby/HEY-CODE/zerocodein/backboard/cli-ts/src/entrypoints/cli.tsx";

interface NdjsonEvent {
	readonly type?: string;
	readonly payload?: {
		readonly text?: string;
		readonly name?: string;
		readonly execution?: { readonly outcome?: string };
		readonly phase?: string;
		readonly output?: string;
	};
}

/** Drive cli-ts headlessly in a given worktree; maps its NDJSON stream to RuntimeEvents. */
export class CliTsRuntime implements AgentRuntimeAdapter {
	async startSession(spec: SessionSpec): Promise<SessionHandle> {
		// Sessions are created lazily at run() time in --print mode;
		// the handle binds identity + workspace now.
		return { id: `zci-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, worktreePath: spec.worktreePath };
	}

	async *run(handle: SessionHandle & { spec?: SessionSpec }): AsyncIterable<RuntimeEvent> {
		const spec = handle.spec;
		if (!spec) {
			yield { type: "error", error: "missing session spec on handle" };
			return;
		}
		const proc = Bun.spawn(
			[
				"bun", "run", CLI_TS_ENTRY,
				"--print", spec.prompt,
				"--permission-mode", spec.permissionMode,
				"--format", "json",
			],
			{ cwd: spec.worktreePath, stdout: "pipe", stderr: "pipe" },
		);
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("{")) continue;
				let ev: NdjsonEvent;
				try {
					ev = JSON.parse(trimmed) as NdjsonEvent;
				} catch {
					continue;
				}
				const mapped = mapEvent(ev);
				if (mapped) yield mapped;
			}
		}
		const code = await proc.exited;
		if (code !== 0) {
			yield { type: "error", error: `cli-ts exited ${code}` };
		} else {
			yield { type: "done" };
		}
	}

	async terminate(_handle: SessionHandle): Promise<void> {
		// --print sessions are one-shot; a --serve driver would kill the process here.
	}
}

function mapEvent(ev: NdjsonEvent): RuntimeEvent | undefined {
	switch (ev.type) {
		case "assistant:delta":
		case "assistant:message":
			return { type: "message", text: ev.payload?.text };
		case "tool:start":
			return { type: "tool:start", toolName: ev.payload?.name };
		case "tool:result":
			return {
				type: "tool:result",
				toolName: ev.payload?.name,
				output: ev.payload?.execution?.outcome,
			};
		case "turn:error":
			return { type: "error", error: ev.payload?.output ?? "provider error" };
		default:
			return undefined;
	}
}

/** Deterministic runtime for tests/demos — executes canned behaviours, no model calls. */
export class FakeRuntime implements AgentRuntimeAdapter {
	/** role → async generator producing canned events; may write files into spec.worktreePath. */
	constructor(
		private readonly behaviours: Record<
			string,
			(spec: SessionSpec) => AsyncIterable<RuntimeEvent>
		>,
	) {}

	async startSession(spec: SessionSpec): Promise<SessionHandle & { spec: SessionSpec }> {
		return { id: `fake-${spec.role}-${Date.now()}`, worktreePath: spec.worktreePath, spec };
	}

	async *run(handle: SessionHandle & { spec: SessionSpec }): AsyncIterable<RuntimeEvent> {
		const behaviour = this.behaviours[handle.spec.role];
		if (!behaviour) {
			yield { type: "error", error: `no fake behaviour for role ${handle.spec.role}` };
			return;
		}
		yield* behaviour(handle.spec);
		yield { type: "done" };
	}

	async terminate(_handle: SessionHandle): Promise<void> {}
}
