// A1 Agent runtime adapter — two implementations:
//   CliTsRuntime: drives the vendored cli-ts in --print NDJSON mode.
//   FakeRuntime: deterministic stub for tests (no model calls).
// Both keep a runtime-owned session registry keyed by handle id, so the
// adapter contract stays clean — callers pass SessionHandle only.

import type {
	AgentRuntimeAdapter,
	RuntimeEvent,
	SessionHandle,
	SessionSpec,
} from "./contracts.ts";

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

/** Minimal process surface run() needs — injectable for tests.
 *  Contract: kill() must cause stdout to end and exited to resolve, so a
 *  terminated process can never leave the event iterator hanging. */
export interface SpawnedProcess {
	readonly stdout: unknown; // ReadableStream<Uint8Array> or AsyncIterable<Uint8Array>
	readonly stderr?: unknown;
	readonly exited: Promise<number>;
	kill(): void;
}

export type SpawnFn = (argv: readonly string[], cwd: string) => SpawnedProcess;

export interface CliTsRuntimeOptions {
	/** Absolute path to the cli-ts entrypoint. Defaults to ../cli-ts relative to this package. */
	readonly cliEntry?: string;
	/** Process spawn override for tests. */
	readonly spawn?: SpawnFn;
}

function defaultCliEntry(): string {
	// src/adapters/runtime.ts → ../../../cli-ts/src/entrypoints/cli.tsx
	return new URL("../../../cli-ts/src/entrypoints/cli.tsx", import.meta.url).pathname;
}

const defaultSpawn: SpawnFn = (argv, cwd) =>
	Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedProcess;

const STDERR_TAIL_BYTES = 4096;

/** Drain a stderr stream concurrently, retaining only a bounded trailing
 *  window for diagnostics. Never blocks the caller; resolves on stream end. */
function drainStderr(stderr: unknown, max = STDERR_TAIL_BYTES): Promise<string> {
	if (!stderr) return Promise.resolve("");
	let tail = "";
	const decoder = new TextDecoder();
	return (async () => {
		for await (const chunk of stderr as AsyncIterable<Uint8Array>) {
			tail += decoder.decode(chunk, { stream: true });
			if (tail.length > max) tail = tail.slice(-max);
		}
		return tail;
	})().catch(() => tail);
}

/** Drive cli-ts headlessly in a given worktree; maps its NDJSON stream to RuntimeEvents. */
export class CliTsRuntime implements AgentRuntimeAdapter {
	private readonly sessions = new Map<string, SessionSpec>();
	private readonly procs = new Map<string, SpawnedProcess>();
	private readonly running = new Set<string>();
	private readonly dead = new Set<string>();
	readonly cliEntry: string;
	private readonly spawn: SpawnFn;

	constructor(options: CliTsRuntimeOptions = {}) {
		this.cliEntry = options.cliEntry ?? defaultCliEntry();
		this.spawn = options.spawn ?? defaultSpawn;
	}

	/** argv handed to the cli-ts entrypoint for a session — the model gateway
	 *  output reaches execution here as `--model provider/model`. */
	static buildArgs(spec: SessionSpec): readonly string[] {
		return [
			"--print", spec.prompt,
			"--model", `${spec.model.provider}/${spec.model.model}`,
			"--permission-mode", spec.permissionMode,
			"--format", "json",
		];
	}

	async startSession(spec: SessionSpec): Promise<SessionHandle> {
		// Sessions are created lazily at run() time in --print mode;
		// the spec is retained in the registry keyed by handle id.
		const id = `zci-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.sessions.set(id, spec);
		return { id, worktreePath: spec.worktreePath };
	}

	async *run(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
		const spec = this.sessions.get(handle.id);
		if (!spec) {
			yield { type: "error", error: `unknown session ${handle.id}` };
			return;
		}
		if (!spec.model?.provider || !spec.model?.model) {
			yield { type: "error", error: `session ${handle.id} has no model selection` };
			return;
		}
		// Explicit supported behavior: one run per session — sessions are
		// one-shot in --print mode and a second consumer would split events.
		if (this.running.has(handle.id)) {
			yield { type: "error", error: `session ${handle.id} is already running` };
			return;
		}
		this.running.add(handle.id);
		try {
			let proc: SpawnedProcess;
			try {
				proc = this.spawn(
					["bun", "run", this.cliEntry, ...CliTsRuntime.buildArgs(spec)],
					spec.worktreePath,
				);
			} catch (e) {
				yield { type: "error", error: `spawn failed: ${(e as Error).message}` };
				return;
			}
			this.procs.set(handle.id, proc);
			// terminate() may have raced the spawn: if the session is already
			// dead or gone, kill immediately rather than start work.
			if (this.dead.has(handle.id) || !this.sessions.has(handle.id)) {
				proc.kill();
			}
			const stderrTail = drainStderr(proc.stderr);
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
				if (this.dead.has(handle.id)) break; // terminated mid-stream
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
			const [code, tail] = await Promise.all([proc.exited, stderrTail]);
			if (this.dead.has(handle.id)) {
				yield { type: "error", error: `session ${handle.id} terminated` };
			} else if (code !== 0) {
				yield { type: "error", error: `cli-ts exited ${code}${tail.trim() ? ` — ${tail.trim()}` : ""}` };
			} else {
				yield { type: "done" };
			}
		} finally {
			// Every exit path — done, error, spawn failure, termination —
			// drops the process handle, the session spec and the markers.
			this.procs.delete(handle.id);
			this.running.delete(handle.id);
			this.sessions.delete(handle.id);
			this.dead.delete(handle.id);
		}
	}

	/** Deterministic at any lifecycle point:
	 *  - before run(): session spec is dropped → run() reports unknown session.
	 *  - during spawn/run(): process is killed; run()'s dead-check exits promptly.
	 *  - after completion: registry already clean → no-op. */
	async terminate(handle: SessionHandle): Promise<void> {
		this.sessions.delete(handle.id);
		const proc = this.procs.get(handle.id);
		if (proc) {
			this.dead.add(handle.id);
			proc.kill();
			await Promise.race([proc.exited, Bun.sleep(2000)]).catch(() => {});
		}
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
	private readonly sessions = new Map<string, SessionSpec>();
	/** Session ids passed to terminate() — test-visible. */
	readonly terminated: string[] = [];

	/** role → async generator producing canned events; may write files into spec.worktreePath. */
	constructor(
		private readonly behaviours: Record<
			string,
			(spec: SessionSpec) => AsyncIterable<RuntimeEvent>
		>,
	) {}

	/** Specs captured at session start — lets tests assert model resolution. */
	getSessionSpec(id: string): SessionSpec | undefined {
		return this.sessions.get(id);
	}

	async startSession(spec: SessionSpec): Promise<SessionHandle> {
		const id = `fake-${spec.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.sessions.set(id, spec);
		return { id, worktreePath: spec.worktreePath };
	}

	async *run(handle: SessionHandle): AsyncIterable<RuntimeEvent> {
		const spec = this.sessions.get(handle.id);
		if (!spec) {
			yield { type: "error", error: `unknown session ${handle.id}` };
			return;
		}
		const behaviour = this.behaviours[spec.role];
		if (!behaviour) {
			yield { type: "error", error: `no fake behaviour for role ${spec.role}` };
			return;
		}
		yield* behaviour(spec);
		yield { type: "done" };
	}

	async terminate(handle: SessionHandle): Promise<void> {
		this.terminated.push(handle.id);
		this.sessions.delete(handle.id);
	}
}
