// Orchestrator unit + integration tests. Real git in temp repos; FakeRuntime
// for deterministic agent behaviour (no model calls, no cost).

import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { RealGitAdapter } from "../src/adapters/git.ts";
import { FakeRuntime } from "../src/adapters/runtime.ts";
import { ConfigModelProvider, DEFAULT_PROVIDER_CONFIG } from "../src/adapters/providers.ts";
import { ConsoleIdeAdapter } from "../src/adapters/ide.ts";
import { ExecutionAdapterImpl } from "../src/adapters/execution.ts";
import type { SessionSpec, RuntimeEvent } from "../src/adapters/contracts.ts";
import type { EventType, OrchestratorEvent } from "../src/types.ts";

async function* writeFile(name: string, content: string): AsyncIterable<RuntimeEvent> {
	yield { type: "tool:start", toolName: "Write" };
	yield { type: "tool:result", toolName: "Write", output: `wrote ${name}` };
}

function makeRuntime(files: Record<string, string>) {
	return new FakeRuntime({
		"pm": async function* (spec: SessionSpec) {
			writeFileSync(`${spec.worktreePath}/PLAN.md`, files["PLAN.md"] ?? "# plan");
			yield* writeFile("PLAN.md", "");
		},
		"architect": async function* (spec: SessionSpec) {
			writeFileSync(`${spec.worktreePath}/ARCHITECTURE.md`, "# arch");
			writeFileSync(
				`${spec.worktreePath}/TASKS.json`,
				files["TASKS.json"] ??
					JSON.stringify([
						{ id: "010", title: "UI", role: "frontend-dev", prompt: "build ui", dependsOn: [] },
						{ id: "011", title: "API", role: "backend-dev", prompt: "build api", dependsOn: [] },
					]),
			);
			yield* writeFile("TASKS.json", "");
		},
		"frontend-dev": async function* (spec: SessionSpec) {
			writeFileSync(`${spec.worktreePath}/ui.js`, files["ui.js"] ?? "export const ui = 1;\n");
			yield* writeFile("ui.js", "");
		},
		"backend-dev": async function* (spec: SessionSpec) {
			writeFileSync(`${spec.worktreePath}/api.js`, files["api.js"] ?? "export const api = 1;\n");
			yield* writeFile("api.js", "");
		},
	});
}

function fixture(files: Record<string, string> = {}) {
	const repo = mkdtempSync(join(tmpdir(), "zci-test-"));
	const g = ["git", "-C", repo];
	const run = (args: string[]) => Bun.spawnSync([...g, ...args]);
	run(["init", "-q"]);
	writeFileSync(join(repo, "README.md"), "# t\n");
	run(["add", "-A"]);
	run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
	const events: OrchestratorEvent[] = [];
	const git = new RealGitAdapter();
	const runtime = makeRuntime(files);
	const exec = new ExecutionAdapterImpl(runtime);
	const orch = new Orchestrator({
		repoPath: repo,
		git,
		runtime,
		providers: new ConfigModelProvider(DEFAULT_PROVIDER_CONFIG),
		ide: new ConsoleIdeAdapter(),
		execution: exec,
		sink: (e) => events.push({ ...e, seq: 0, at: 0 }),
	});
	return { repo, orch, events, git };
}

describe("state transitions", () => {
	it("walks draft -> planned -> queued -> assigned -> running -> review", async () => {
		const { orch } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		expect(t.status).toBe("planned");
		await orch.runTask(t.id);
		expect(orch.getTask(t.id)!.status).toBe("review");
		const transitions = orch.getEvents().filter((e) => e.type === "task:transition").map((e) => (e.data as any).to);
		expect(transitions).toEqual(["planned", "queued", "assigned", "running", "review"]);
	});

	it("rejects illegal transition (approve a running task)", async () => {
		const { orch } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await expect(orch.approve(t.id)).rejects.toThrow("not awaiting review");
	});

	it("rejects unknown dependency", () => {
		const { orch } = fixture();
		expect(() =>
			orch.createTask({ title: "x", role: "pm", spec: { prompt: "p" }, dependsOn: ["task_999"] }),
		).toThrow("unknown dependency");
	});
});

describe("dependency handling", () => {
	it("blocks queued task until dependency is done/merged", async () => {
		const { orch } = fixture();
		const a = orch.createTask({ title: "a", role: "frontend-dev", spec: { prompt: "a" } });
		const b = orch.createTask({ title: "b", role: "backend-dev", spec: { prompt: "b" }, dependsOn: [a.id] });
		await orch.runReadyTasks();
		expect(orch.getTask(a.id)!.status).toBe("review");
		expect(orch.getTask(b.id)!.status).toBe("planned"); // not queued: dep is in review, not done
	});

	it("runs parallel tasks concurrently in separate worktrees", async () => {
		const { orch, events } = fixture();
		const a = orch.createTask({ title: "a", role: "frontend-dev", spec: { prompt: "a" } });
		const b = orch.createTask({ title: "b", role: "backend-dev", spec: { prompt: "b" } });
		await orch.runReadyTasks();
		const wa = orch.getTask(a.id)!.worktreePath!;
		const wb = orch.getTask(b.id)!.worktreePath!;
		expect(wa).not.toBe(wb);
		expect(wa).toContain(".zci-worktrees/");
		expect(orch.getTask(a.id)!.status).toBe("review");
		expect(orch.getTask(b.id)!.status).toBe("review");
		expect(events.filter((e) => e.type === "worktree:created").length).toBe(2);
	});
});

describe("worktree isolation + merge protection", () => {
	it("agent writes land in worktree, parent stays clean until approved merge", async () => {
		const { orch, repo } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const wt = orch.getTask(t.id)!.worktreePath!;
		expect(existsSync(join(wt, "ui.js"))).toBe(true);      // agent's file in worktree
		expect(existsSync(join(repo, "ui.js"))).toBe(false);   // parent untouched
		const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]).stdout.toString();
		expect(status).toContain(".zci-worktrees/");           // only the worktree dir is new
	});

	it("applies approved work to parent via git adapter only", async () => {
		const { orch, repo } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		await orch.approve(t.id, "cto");
		await orch.mergeApproved();
		expect(existsSync(join(repo, "ui.js"))).toBe(true);
		const task = orch.getTask(t.id)!;
		expect(task.status).toBe("done");
		expect(task.resultCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(task.approvedBy).toBe("cto");
	});

	it("protection: merge throws if approved flag somehow bypassed", async () => {
		const { orch } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		// Force status to approved without going through approve()
		orch.getTask(t.id)!.status = "approved";
		await expect(orch.mergeApproved()).rejects.toThrow("protection triggered");
	});

	it("merge happens in dependency order", async () => {
		const { orch } = fixture();
		const a = orch.createTask({ title: "a", role: "frontend-dev", spec: { prompt: "a" } });
		const b = orch.createTask({ title: "b", role: "backend-dev", spec: { prompt: "b" }, dependsOn: [a.id] });
		await orch.runTask(a.id);
		await orch.approve(a.id);
		await orch.mergeApproved();           // a -> done, unlocks b
		await orch.runTask(b.id);
		await orch.approve(b.id);
		await orch.mergeApproved();
		const merges = orch.getEvents().filter((e) => e.type === "merge:completed").map((e) => e.taskId);
		expect(merges).toEqual([a.id, b.id]);
	});
});

describe("event traceability", () => {
	it("emits a full lifecycle event trail", async () => {
		const { orch, events } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		await orch.approve(t.id);
		await orch.mergeApproved();
		const types = events.map((e) => e.type);
		const required: EventType[] = ["task:created", "worktree:created", "agent:assigned", "agent:completed", "diff:ready", "approval:granted", "merge:completed"];
		for (const req of required) {
			expect(types).toContain(req);
		}
	});
});

describe("adapter contracts", () => {
	it("model provider resolves by task class, not by name", () => {
		const p = new ConfigModelProvider({
			plan: { provider: "plan-prov", model: "m1" },
			design: { provider: "design-prov", model: "m2" },
			build: { provider: "build-prov", model: "m3" },
			verify: { provider: "verify-prov", model: "m4" },
		});
		expect(p.resolve("plan", "pm").provider).toBe("plan-prov");
		expect(p.resolve("build", "frontend-dev").model).toBe("m3");
	});

	it("role override beats task class", () => {
		const p = new ConfigModelProvider({
			...DEFAULT_PROVIDER_CONFIG,
			roleOverrides: { "frontend-dev": { provider: "special", model: "ui-model" } },
		});
		expect(p.resolve("build", "frontend-dev").model).toBe("ui-model");
		expect(p.resolve("build", "backend-dev").provider).toBe("anthropic-subscription");
	});
});

describe("idea → plan → arch → dev flow", () => {
	it("runs PM then materializes dev tasks from architect output", async () => {
		const { orch } = fixture();
		const pm = await orch.submitIdea("todo app");
		expect(pm.status).toBe("review");
		const arch = await orch.approvePlan(pm.id, "cto");
		expect(arch.status).toBe("review");
		const devs = await orch.materializeGraph(arch.id);
		expect(devs.length).toBe(2);
		expect(devs.map((d) => d.role).sort()).toEqual(["backend-dev", "frontend-dev"]);
		// every dev task depends on the architect
		for (const d of devs) expect(d.dependsOn).toContain(arch.id);
	});
});
