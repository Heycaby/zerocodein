// ZeroCodeIn Orchestrator — source of truth for task state, dependencies,
// assignments, approvals and agent lifecycle. Never writes repository content;
// all repo writes go through the GitAdapter (A4). Runtime- and provider-agnostic.

import type {
	AgentRuntimeAdapter,
	ExecutionAdapter,
	GitAdapter,
	IdeAdapter,
	ModelProviderAdapter,
	SessionSpec,
	WorktreeInfo,
} from "./adapters/contracts.ts";
import type {
	AgentRole,
	EventSink,
	EventType,
	OrchestratorEvent,
	Task,
	TaskSpec,
	TaskStatus,
} from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import { getAgent } from "./registry.ts";

const ALLOWED: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	draft: ["planned", "cancelled"],
	planned: ["queued", "cancelled"],
	queued: ["assigned", "cancelled"],
	assigned: ["running", "failed", "cancelled"],
	running: ["review", "failed", "blocked", "cancelled"],
	review: ["approved", "rejected", "blocked"],
	approved: ["merging", "cancelled"],
	merging: ["merged", "blocked"],
	merged: ["done", "failed"],
	rejected: ["queued", "cancelled"],
	blocked: ["queued", "cancelled"],
	failed: ["queued", "cancelled"],
	cancelled: [],
	done: [],
};

export interface OrchestratorDeps {
	readonly repoPath: string;          // protected parent repository
	readonly git: GitAdapter;
	readonly runtime: AgentRuntimeAdapter;
	readonly providers: ModelProviderAdapter;
	readonly ide: IdeAdapter;
	readonly execution: ExecutionAdapter;
	readonly sink?: EventSink;
	/** When true, merges require an explicit approve() call. Default true. */
	readonly requireApproval?: boolean;
}

export interface TaskGraphEntry {
	readonly id: string;
	readonly title: string;
	readonly role: AgentRole;
	readonly prompt: string;
	readonly dependsOn?: readonly string[];
	readonly testCommand?: string;
}

let seq = 0;

export class Orchestrator {
	private readonly tasks = new Map<string, Task>();
	private readonly worktrees = new Map<string, WorktreeInfo>();
	private readonly log: OrchestratorEvent[] = [];
	private readonly requireApproval: boolean;

	constructor(private readonly deps: OrchestratorDeps) {
		this.requireApproval = deps.requireApproval ?? true;
	}

	// ---- inspection ----
	getTask(id: string): Task | undefined { return this.tasks.get(id); }
	getTasks(): readonly Task[] { return [...this.tasks.values()]; }
	getEvents(): readonly OrchestratorEvent[] { return this.log; }

	private emit(type: EventType, data: Omit<OrchestratorEvent, "seq" | "at" | "type">): void {
		const e = { ...data, type };
		this.log.push({ ...e, seq: seq++, at: Date.now() });
		this.deps.sink?.(e);
	}

	private transition(task: Task, to: TaskStatus, reason?: string): void {
		if (!ALLOWED[task.status].includes(to)) {
			throw new Error(`illegal transition ${task.status} -> ${to} for task ${task.id}`);
		}
		task.status = to;
		task.statusReason = reason;
		this.emit("task:transition", { taskId: task.id, agentRole: task.role, data: { from: task.status, to, reason } });
	}

	// ---- task lifecycle ----

	createTask(input: {
		title: string;
		role: AgentRole;
		spec: TaskSpec;
		dependsOn?: readonly string[];
	}): Task {
		const id = `task_${(this.tasks.size + 1).toString().padStart(3, "0")}`;
		for (const dep of input.dependsOn ?? []) {
			if (!this.tasks.has(dep)) throw new Error(`unknown dependency ${dep} for ${id}`);
		}
		if (this.wouldCycle(id, input.dependsOn ?? [])) {
			throw new Error(`dependency cycle detected for ${id}`);
		}
		const task: Task = {
			id,
			title: input.title,
			role: input.role,
			spec: input.spec,
			dependsOn: input.dependsOn ?? [],
			createdAt: Date.now(),
			status: "draft",
		};
		this.tasks.set(id, task);
		this.emit("task:created", { taskId: id, agentRole: task.role, data: { title: task.title } });
		this.transition(task, "planned");
		return task;
	}

	private wouldCycle(id: string, deps: readonly string[]): boolean {
		const seen = new Set<string>([id]);
		const stack = [...deps];
		while (stack.length) {
			const cur = stack.pop()!;
			if (seen.has(cur)) return true;
			seen.add(cur);
			stack.push(...(this.tasks.get(cur)?.dependsOn ?? []));
		}
		return false;
	}

	/** Move tasks whose dependencies all reached a satisfied state to queued.
	 *  `approved` counts as satisfied: dependents may proceed while the dep's
	 *  merge is still pending — merge order is enforced separately by topoSort. */
	private refreshQueue(): Task[] {
		const ready: Task[] = [];
		for (const t of this.tasks.values()) {
			if (t.status !== "planned") continue;
			const ok = t.dependsOn.every((d) =>
				["done", "merged", "approved"].includes(this.tasks.get(d)?.status ?? ""),
			);
			if (ok) {
				this.transition(t, "queued");
				ready.push(t);
			}
		}
		return ready;
	}

	// ---- idea → plan → architecture flow ----

	async submitIdea(idea: string): Promise<Task> {
		this.emit("idea:submitted", { data: { idea } });
		const pm = this.createTask({
			title: `Plan: ${idea.slice(0, 60)}`,
			role: "pm",
			spec: { prompt: idea },
		});
		await this.runTask(pm.id);
		return pm;
	}

	/** User approves the PM's plan → spawns the architect task. */
	async approvePlan(pmTaskId: string, approvedBy = "user"): Promise<Task> {
		const pm = this.mustGet(pmTaskId);
		if (pm.status !== "review") throw new Error(`plan task ${pmTaskId} is not awaiting review (${pm.status})`);
		this.transition(pm, "approved");
		pm.approvedBy = approvedBy;
		this.emit("plan:approved", { taskId: pm.id, data: { approvedBy } });
		const arch = this.createTask({
			title: `Architecture for ${pm.title}`,
			role: "architect",
			spec: { prompt: pm.spec.prompt, context: pm.output ?? pm.spec.context },
			dependsOn: [pm.id],
		});
		// PM output is an artifact — treat plan approval as satisfying the dep.
		this.transition(pm, "merging");
		await this.mergeTask(pm);
		this.transition(pm, "done");
		await this.runTask(arch.id);
		return arch;
	}

	/** After the architect runs, materialize its TASKS.json into dev tasks. */
	async materializeGraph(archTaskId: string): Promise<readonly Task[]> {
		const arch = this.mustGet(archTaskId);
		if (arch.status !== "review") throw new Error(`architect task ${archTaskId} not in review`);
		const wt = this.worktrees.get(arch.id);
		if (!wt) throw new Error("architect worktree missing");
		const raw = await Bun.file(`${wt.path}/TASKS.json`).text();
		const entries = JSON.parse(raw) as TaskGraphEntry[];
		const created: Task[] = [];
		for (const e of entries) {
			const mapped = (e.dependsOn ?? []).map((d) => {
				const t = created.find((c) => c.id === `task_${d}` || c.title === d);
				return t?.id ?? `task_${d}`;
			});
			const t = this.createTask({
				title: e.title,
				role: e.role,
				spec: { prompt: e.prompt, context: arch.output, testCommand: e.testCommand },
				dependsOn: [arch.id, ...mapped],
			});
			created.push(t);
		}
		this.emit("graph:materialized", { data: { count: created.length } });
		return created;
	}

	// ---- execution ----

	private mustGet(id: string): Task {
		const t = this.tasks.get(id);
		if (!t) throw new Error(`unknown task ${id}`);
		return t;
	}

	private renderPrompt(task: Task): string {
		return getAgent(task.role).promptTemplate
			.replaceAll("{task}", task.spec.prompt)
			.replaceAll("{context}", task.spec.context ?? "");
	}

	async runTask(taskId: string): Promise<void> {
		const task = this.mustGet(taskId);
		if (task.status === "planned") {
			const ready = task.dependsOn.every(
				(d) => ["done", "merged", "approved"].includes(this.tasks.get(d)?.status ?? ""),
			);
			if (ready) this.transition(task, "queued");
		}
		if (task.status !== "queued") {
			throw new Error(`task ${taskId} not runnable (${task.status})`);
		}
		const agent = getAgent(task.role);
		// RULE: agents never see the parent repo path — only their worktree.
		const wt = await this.deps.git.createWorktree(this.deps.repoPath, task.id);
		this.worktrees.set(task.id, wt);
		task.worktreePath = wt.path;
		task.branch = wt.branch;
		this.emit("worktree:created", { taskId: task.id, data: { path: wt.path, branch: wt.branch } });

		const spec: SessionSpec = {
			worktreePath: wt.path,
			role: task.role,
			prompt: this.renderPrompt(task),
			model: this.deps.providers.resolve(agent.taskClass, task.role),
			permissionMode: agent.permissionMode,
		};
		const handle = await this.deps.execution.dispatch(spec, "local");
		task.assignedSession = handle.id;
		this.transition(task, "assigned");
		this.emit("agent:assigned", { taskId: task.id, agentRole: task.role, data: { session: handle.id, model: spec.model } });
		this.transition(task, "running");

		try {
			const outputParts: string[] = [];
			for await (const ev of this.deps.runtime.run(handle as never)) {
				this.emit("agent:event", { taskId: task.id, agentRole: task.role, data: { type: ev.type, tool: ev.toolName } });
				if (ev.type === "error") throw new Error(ev.error ?? "agent error");
				if (ev.type === "tool:result" && ev.output) outputParts.push(ev.output);
			}
			task.output = outputParts.join("\n").slice(0, 4000);
			// Commit the work, compute the review diff, park in review.
			await this.deps.git.commitAll(wt.path, `zerocodein(${task.role}): ${task.title}`);
			const diff = await this.deps.git.getDiff(wt.path, wt.baseRef);
			task.diffSummary = `${diff.filesChanged} files, +${diff.insertions}/-${diff.deletions}`;
			this.emit("diff:ready", { taskId: task.id, data: { summary: task.diffSummary, newFiles: diff.newFiles } });
			this.emit("agent:completed", { taskId: task.id, agentRole: task.role });
			this.transition(task, "review");
			this.refreshQueue();
		} catch (e) {
			task.error = (e as Error).message;
			this.emit("agent:failed", { taskId: task.id, agentRole: task.role, data: { error: task.error } });
			this.transition(task, "failed", task.error);
		}
	}

	/** Run all tasks whose dependencies are satisfied, in parallel worktrees. */
	async runReadyTasks(): Promise<readonly Task[]> {
		const ready = this.refreshQueue();
		await Promise.all(ready.map((t) => this.runTask(t.id)));
		return ready;
	}

	// ---- review / approval / merge ----

	/** User reviews and approves a task's diff. Records the approver. */
	async approve(taskId: string, approvedBy = "user"): Promise<void> {
		const task = this.mustGet(taskId);
		if (task.status !== "review") throw new Error(`task ${taskId} not awaiting review (${task.status})`);
		const wt = this.worktrees.get(task.id);
		if (!wt) throw new Error("worktree missing");
		const diff = await this.deps.git.getDiff(wt.path, wt.baseRef);
		this.deps.ide.showDiff(task.id, wt.path, diff.patch || task.diffSummary || "(no patch)");
		this.emit("approval:requested", { taskId: task.id });
		this.transition(task, "approved");
		task.approvedBy = approvedBy;
		this.emit("approval:granted", { taskId: task.id, data: { approvedBy } });
	}

	async reject(taskId: string, reason: string, rejectedBy = "user"): Promise<void> {
		const task = this.mustGet(taskId);
		if (task.status !== "review") throw new Error(`task ${taskId} not awaiting review`);
		this.transition(task, "rejected", reason);
		task.approvedBy = rejectedBy;
		this.emit("approval:denied", { taskId: task.id, data: { reason } });
	}

	/** Merge every approved task in dependency order. The ONLY merge path. */
	async mergeApproved(): Promise<readonly Task[]> {
		const approved = this.getTasks().filter((t) => t.status === "approved");
		const ordered = this.topoSort(approved);
		const done: Task[] = [];
		for (const task of ordered) {
			if (this.requireApproval && !task.approvedBy) {
				throw new Error(`task ${task.id} reached merge without approval — protection triggered`);
			}
			this.transition(task, "merging");
			await this.mergeTask(task);
			if (task.spec.testCommand) {
				this.emit("verify:started", { taskId: task.id, data: { cmd: task.spec.testCommand } });
				const ok = await this.runTestCommand(task.spec.testCommand);
				if (!ok) {
					this.emit("verify:failed", { taskId: task.id });
					this.transition(task, "failed", "post-merge test failed");
					continue;
				}
				this.emit("verify:passed", { taskId: task.id });
			}
			this.transition(task, "done");
			done.push(task);
			this.refreshQueue();
		}
		return done;
	}

	private async mergeTask(task: Task): Promise<void> {
		const wt = this.worktrees.get(task.id);
		if (!wt) throw new Error(`worktree missing for ${task.id}`);
		this.emit("merge:started", { taskId: task.id, data: { branch: wt.branch } });
		try {
			const result = await this.deps.git.applyToParent(this.deps.repoPath, wt);
			task.resultCommit = result.commit;
			this.transition(task, "merged");
			this.emit("merge:completed", { taskId: task.id, data: { commit: result.commit } });
		} catch (e) {
			this.emit("merge:failed", { taskId: task.id, data: { error: (e as Error).message } });
			this.transition(task, "blocked", (e as Error).message);
			throw e;
		}
	}

	private async runTestCommand(cmd: string): Promise<boolean> {
		const proc = Bun.spawn(["sh", "-c", cmd], { cwd: this.deps.repoPath, stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		return proc.exitCode === 0;
	}

	private topoSort(tasks: readonly Task[]): Task[] {
		const result: Task[] = [];
		const seen = new Set<string>();
		const visit = (t: Task) => {
			if (seen.has(t.id)) return;
			seen.add(t.id);
			for (const d of t.dependsOn) {
				const dt = this.tasks.get(d);
				if (dt && tasks.includes(dt)) visit(dt);
			}
			result.push(t);
		};
		for (const t of tasks) visit(t);
		return result;
	}

	async cancel(taskId: string): Promise<void> {
		const task = this.mustGet(taskId);
		if (TERMINAL_STATES.has(task.status)) throw new Error(`task ${taskId} already ${task.status}`);
		this.transition(task, "cancelled", "user cancelled");
	}
}
