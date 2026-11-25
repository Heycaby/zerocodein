// ZeroCodeIn core domain types.
// Orchestrator owns task state; git owns repository state. These types never
// blend the two — WorktreeInfo is a handle the orchestrator holds, not repo data.

export type AgentRole = "pm" | "architect" | "frontend-dev" | "backend-dev";

export type TaskStatus =
	| "draft"       // created, not yet planned
	| "planned"     // has spec + deps validated
	| "queued"      // deps satisfied, awaiting dispatch
	| "assigned"    // session created in a worktree
	| "running"     // agent actively working
	| "review"      // agent finished; diff awaiting user review
	| "approved"    // user approved the diff for merge
	| "merging"     // git adapter applying to parent
	| "merged"      // applied to parent repo (git confirmed)
	| "done"        // verified post-merge (tests run)
	| "rejected"    // user rejected diff; work retained in worktree
	| "blocked"     // waiting on external input (question, credential, conflict)
	| "failed"      // agent error or unrecoverable failure
	| "cancelled";  // user cancelled

export const TERMINAL_STATES: ReadonlySet<TaskStatus> = new Set([
	"done", "rejected", "failed", "cancelled",
]);

export interface TaskSpec {
	readonly prompt: string;            // instruction handed to the agent
	readonly context?: string;          // additional context (plan, arch doc)
	readonly filesHint?: readonly string[];
	readonly testCommand?: string;      // run post-merge to reach "done"
}

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly role: AgentRole;
	readonly spec: TaskSpec;
	readonly dependsOn: readonly string[];      // task ids
	readonly createdAt: number;
	status: TaskStatus;
	statusReason?: string;
	assignedSession?: string;                    // A1 session handle
	worktreePath?: string;                       // A4 handle — orchestrator keeps the path only
	branch?: string;
	diffSummary?: string;
	resultCommit?: string;                       // merge commit hash, recorded as evidence
	approvedBy?: string;
	verifyApprovedBy?: string;               // who approved spec.testCommand for execution
	mergeOrder?: number;
	output?: string;                             // agent's structured output (plan/arch/notes)
	error?: string;
}

export type TaskClass = "plan" | "design" | "build" | "verify";

export interface ModelRef {
	readonly provider: string;          // e.g. "anthropic-subscription", "openai"
	readonly model: string;             // provider-specific model id or "default"
}

export type PermissionMode = "manual" | "acceptEdits" | "auto" | "bypass";

export interface AgentDefinition {
	readonly role: AgentRole;
	readonly name: string;
	readonly responsibility: string;
	readonly taskClass: TaskClass;
	readonly promptTemplate: string;    // rendered with {task}, {context}
	readonly permissionMode: PermissionMode;
	readonly mayWriteParent: boolean;   // always false for MVP specialists
	readonly expectsStructuredOutput?: string; // e.g. "task-graph-json"
}

// --- Structured event model (every agent action traceable) ---

export type EventType =
	| "task:created" | "task:transition" | "task:blocked"
	| "agent:assigned" | "agent:event" | "agent:completed" | "agent:failed"
	| "worktree:created" | "worktree:removed"
	| "diff:ready" | "approval:requested" | "approval:granted" | "approval:denied"
	| "merge:started" | "merge:completed" | "merge:failed"
	| "verify:started" | "verify:passed" | "verify:failed" | "verify:approved" | "verify:skipped"
	| "idea:submitted" | "plan:approved" | "graph:materialized";

export interface OrchestratorEvent {
	readonly seq: number;
	readonly at: number;
	readonly type: EventType;
	readonly taskId?: string;
	readonly agentRole?: AgentRole;
	readonly data?: Record<string, unknown>;
}

export type EventSink = (e: Omit<OrchestratorEvent, "seq" | "at">) => void;
