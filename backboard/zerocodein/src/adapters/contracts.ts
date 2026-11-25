// The five ZeroCodeIn adapter contracts (A1-A5).
// The orchestrator depends ONLY on these interfaces — never on a concrete
// runtime, provider, IDE, git binary, or execution environment.

import type {
	AgentRole,
	ModelRef,
	PermissionMode,
	TaskClass,
} from "../types.ts";

// ---- A1: Agent runtime adapter ----

export interface SessionSpec {
	readonly worktreePath: string;
	readonly role: AgentRole;
	readonly prompt: string;
	readonly model: ModelRef;
	readonly permissionMode: PermissionMode;
}

export interface SessionHandle {
	readonly id: string;
	readonly worktreePath: string;
}

export interface RuntimeEvent {
	readonly type: "message" | "tool:start" | "tool:result" | "done" | "error";
	readonly text?: string;
	readonly toolName?: string;
	readonly output?: string;
	readonly error?: string;
}

export interface AgentRuntimeAdapter {
	startSession(spec: SessionSpec): Promise<SessionHandle>;
	/** Drive the session to completion; emits events as they arrive. */
	run(handle: SessionHandle): AsyncIterable<RuntimeEvent>;
	terminate(handle: SessionHandle): Promise<void>;
}

// ---- A2: Model provider adapter ----

export interface ModelProviderAdapter {
	/** Resolve which model a task class uses. Orchestrator names classes, never providers. */
	resolve(taskClass: TaskClass, role: AgentRole): ModelRef;
}

// ---- A3: IDE adapter ----

export interface IdeAdapter {
	notify(message: string, level: "info" | "warn" | "error"): void;
	showDiff(taskId: string, worktreePath: string, diffSummary: string): void;
	/** Ask the user a blocking question; returns their answer. */
	ask(question: string): Promise<string>;
}

// ---- A4: Git adapter — sole writer of repository state ----

export interface WorktreeInfo {
	readonly path: string;
	readonly branch: string;
	readonly baseRef: string;           // parent commit the worktree branched from
}

export interface DiffSummary {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly patch: string;             // full diff text for review
	readonly newFiles: readonly string[];
}

export interface MergeResult {
	readonly commit: string;            // merge commit hash — evidence for the orchestrator
	readonly conflictingFiles: readonly string[];
}

export interface GitAdapter {
	createWorktree(repoPath: string, name: string, baseRef?: string): Promise<WorktreeInfo>;
	getDiff(worktreePath: string, baseRef?: string): Promise<DiffSummary>;
	commitAll(worktreePath: string, message: string): Promise<string>;
	/** The ONLY path by which agent output reaches the parent repository. */
	applyToParent(repoPath: string, worktree: WorktreeInfo): Promise<MergeResult>;
	deleteWorktree(repoPath: string, worktree: WorktreeInfo): Promise<void>;
}

// ---- A5: Execution adapter ----

export type ExecutionEnv = "local" | "cloud";

export interface ExecutionAdapter {
	dispatch(spec: SessionSpec, env: ExecutionEnv): Promise<SessionHandle>;
}
