// Orchestrator unit + integration tests. Real git in temp repos; FakeRuntime
// for deterministic agent behaviour (no model calls, no cost).

import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { RealGitAdapter } from "../src/adapters/git.ts";
import { CliTsRuntime, FakeRuntime } from "../src/adapters/runtime.ts";
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
	return { repo, orch, events, git, runtime };
}

/** Run PM + architect to reach a TASKS.json-bearing arch task in review. */
async function archInReview(orch: Orchestrator) {
	const pm = await orch.submitIdea("todo app");
	const arch = await orch.approvePlan(pm.id, "cto");
	expect(arch.status).toBe("review");
	return arch;
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

describe("review fix 1 — transition event payloads", () => {
	it("emits accurate from/to for the full lifecycle", async () => {
		const { orch } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const pairs = orch.getEvents()
			.filter((e) => e.type === "task:transition")
			.map((e) => [e.data!.from, e.data!.to]);
		expect(pairs).toEqual([
			["draft", "planned"],
			["planned", "queued"],
			["queued", "assigned"],
			["assigned", "running"],
			["running", "review"],
		]);
	});
});

describe("review fix 2 — CliTsRuntime session registry", () => {
	it("errors on an unknown session handle instead of spawning", async () => {
		const rt = new CliTsRuntime({ cliEntry: "/nonexistent/cli.tsx" });
		const evs: RuntimeEvent[] = [];
		for await (const ev of rt.run({ id: "bogus", worktreePath: "/tmp" })) evs.push(ev);
		expect(evs.length).toBe(1);
		expect(evs[0]!.type).toBe("error");
		expect(evs[0]!.error).toContain("unknown session");
	});

	it("concurrent sessions retain distinct specs", async () => {
		const rt = new CliTsRuntime({ cliEntry: "/nonexistent/cli.tsx" });
		const a = await rt.startSession({ worktreePath: "/a", role: "pm", prompt: "p1", model: { provider: "p1", model: "m1" }, permissionMode: "auto" });
		const b = await rt.startSession({ worktreePath: "/b", role: "backend-dev", prompt: "p2", model: { provider: "p2", model: "m2" }, permissionMode: "manual" });
		expect(a.id).not.toBe(b.id);
	});

	it("terminate removes the spec; a later run fails cleanly", async () => {
		const rt = new CliTsRuntime({ cliEntry: "/nonexistent/cli.tsx" });
		const h = await rt.startSession({ worktreePath: "/a", role: "pm", prompt: "p", model: { provider: "p", model: "m" }, permissionMode: "auto" });
		await rt.terminate(h);
		const evs: { type: string; error?: string }[] = [];
		for await (const ev of rt.run(h)) evs.push(ev);
		expect(evs[0]!.type).toBe("error");
	});

	it("resolves the cli-ts entrypoint relative to the package", () => {
		const rt = new CliTsRuntime();
		expect(rt.cliEntry).toContain("cli-ts/src/entrypoints/cli.tsx");
		expect(existsSync(rt.cliEntry)).toBe(true);
	});
});

describe("review fix 3 — model selection reaches the runtime", () => {
	it("spawn receives --model provider/model from the SessionSpec", async () => {
		let argv: readonly string[] = [];
		const rt = new CliTsRuntime({
			cliEntry: "/fake/cli.tsx",
			spawn: (a) => {
				argv = a;
				return {
					stdout: (async function* () { yield new TextEncoder().encode("{}\n"); })(),
					exited: Promise.resolve(0),
					kill() {},
				};
			},
		});
		const h = await rt.startSession({
			worktreePath: "/tmp/x", role: "frontend-dev", prompt: "do x",
			model: { provider: "special", model: "ui-model" }, permissionMode: "auto",
		});
		for await (const _ of rt.run(h)) { /* drain */ }
		const i = argv.indexOf("--model");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("special/ui-model");
		expect(argv).toContain("/fake/cli.tsx");
		expect(argv).toContain("--permission-mode");
	});

	it("orchestrator-resolved model lands in the session spec", async () => {
		const { orch, runtime } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const spec = runtime.getSessionSpec(orch.getTask(t.id)!.assignedSession!);
		expect(spec).toBeDefined();
		expect(spec!.model).toEqual(DEFAULT_PROVIDER_CONFIG.build);
		// agent:assigned event carries the resolved model for traceability
		const ev = orch.getEvents().find((e) => e.type === "agent:assigned")!;
		expect(ev.data!.model).toEqual(DEFAULT_PROVIDER_CONFIG.build);
	});

	it("per-role model override propagates into the session spec", async () => {
		const repo = mkdtempSync(join(tmpdir(), "zci-test-"));
		const run = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
		run(["init", "-q"]); writeFileSync(join(repo, "README.md"), "# t\n");
		run(["add", "-A"]); run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);
		const runtime = makeRuntime({});
		const orch = new Orchestrator({
			repoPath: repo, git: new RealGitAdapter(), runtime,
			providers: new ConfigModelProvider({
				...DEFAULT_PROVIDER_CONFIG,
				roleOverrides: { "frontend-dev": { provider: "openai", model: "gpt-5.5" } },
			}),
			ide: new ConsoleIdeAdapter(),
			execution: new ExecutionAdapterImpl(runtime),
		});
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const spec = runtime.getSessionSpec(orch.getTask(t.id)!.assignedSession!);
		expect(spec!.model).toEqual({ provider: "openai", model: "gpt-5.5" });
	});
});

describe("review fix 4 — task graph materialisation", () => {
	it("materializes tasks that depend on later entries (forward refs)", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([
				{ id: "b", title: "B", role: "backend-dev", prompt: "b", dependsOn: ["a"] },
				{ id: "a", title: "A", role: "frontend-dev", prompt: "a", dependsOn: [] },
			]),
		});
		const arch = await archInReview(orch);
		const devs = await orch.materializeGraph(arch.id);
		expect(devs.length).toBe(2);
		const b = devs.find((d) => d.title === "B")!;
		const a = devs.find((d) => d.title === "A")!;
		expect(b.dependsOn).toContain(a.id);
	});

	it("materializes a task with multiple dependencies", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([
				{ id: "c", title: "C", role: "frontend-dev", prompt: "c", dependsOn: ["a", "b"] },
				{ id: "a", title: "A", role: "frontend-dev", prompt: "a", dependsOn: [] },
				{ id: "b", title: "B", role: "backend-dev", prompt: "b", dependsOn: [] },
			]),
		});
		const arch = await archInReview(orch);
		const devs = await orch.materializeGraph(arch.id);
		const c = devs.find((d) => d.title === "C")!;
		const a = devs.find((d) => d.title === "A")!;
		const b = devs.find((d) => d.title === "B")!;
		expect(c.dependsOn).toContain(a.id);
		expect(c.dependsOn).toContain(b.id);
	});

	it("rejects unknown dependency ids", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([
				{ id: "a", title: "A", role: "frontend-dev", prompt: "a", dependsOn: ["ghost"] },
			]),
		});
		const arch = await archInReview(orch);
		await expect(orch.materializeGraph(arch.id)).rejects.toThrow("unknown task \"ghost\"");
	});

	it("rejects duplicate ids", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([
				{ id: "a", title: "A", role: "frontend-dev", prompt: "a", dependsOn: [] },
				{ id: "a", title: "A2", role: "backend-dev", prompt: "b", dependsOn: [] },
			]),
		});
		const arch = await archInReview(orch);
		await expect(orch.materializeGraph(arch.id)).rejects.toThrow("duplicate task id");
	});

	it("rejects dependency cycles", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([
				{ id: "a", title: "A", role: "frontend-dev", prompt: "a", dependsOn: ["b"] },
				{ id: "b", title: "B", role: "backend-dev", prompt: "b", dependsOn: ["a"] },
			]),
		});
		const arch = await archInReview(orch);
		await expect(orch.materializeGraph(arch.id)).rejects.toThrow("dependency cycle");
	});

	it("rejects unknown roles and invalid JSON without creating tasks", async () => {
		const { orch } = fixture({
			"TASKS.json": JSON.stringify([{ id: "a", title: "A", role: "wizard", prompt: "a" }]),
		});
		const arch = await archInReview(orch);
		const before = orch.getTasks().length;
		await expect(orch.materializeGraph(arch.id)).rejects.toThrow("unknown role");
		expect(orch.getTasks().length).toBe(before);
	});
});

/** Rebuild an orchestrator over an existing repo with swapped adapters. */
function orchOver(repo: string, runtime: FakeRuntime, ide = new ConsoleIdeAdapter()) {
	return new Orchestrator({
		repoPath: repo, git: new RealGitAdapter(), runtime,
		providers: new ConfigModelProvider(DEFAULT_PROVIDER_CONFIG), ide,
		execution: new ExecutionAdapterImpl(runtime),
	});
}

describe("failure + cancellation handling", () => {
	it("agent error → failed state, worktree removed", async () => {
		const { repo } = fixture();
		const runtime = new FakeRuntime({
			"frontend-dev": async function* () { yield { type: "error", error: "agent exploded" }; },
		});
		const orch = orchOver(repo, runtime);
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const failed = orch.getTask(t.id)!;
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("agent exploded");
		expect(failed.worktreePath).toBeDefined();
		expect(existsSync(failed.worktreePath!)).toBe(false);
	});

	it("dispatch failure → failed state, no dangling worktree", async () => {
		const { repo } = fixture();
		const runtime = makeRuntime({});
		const orch = new Orchestrator({
			repoPath: repo, git: new RealGitAdapter(), runtime,
			providers: new ConfigModelProvider(DEFAULT_PROVIDER_CONFIG),
			ide: new ConsoleIdeAdapter(),
			execution: { dispatch: () => Promise.reject(new Error("no runtime available")) },
		});
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const task = orch.getTask(t.id)!;
		expect(task.status).toBe("failed");
		expect(task.error).toContain("no runtime available");
		const worktrees = Bun.spawnSync(["git", "-C", repo, "worktree", "list"]).stdout.toString();
		expect(worktrees).not.toContain(t.id);
	});

	it("cancel terminates the runtime session and removes the worktree", async () => {
		const { orch, repo, runtime } = fixture();
		const t = orch.createTask({ title: "x", role: "frontend-dev", spec: { prompt: "do" } });
		await orch.runTask(t.id);
		const session = orch.getTask(t.id)!.assignedSession!;
		const wt = orch.getTask(t.id)!.worktreePath!;
		await orch.cancel(t.id);
		expect(orch.getTask(t.id)!.status).toBe("cancelled");
		expect(runtime.terminated).toContain(session);
		expect(existsSync(wt)).toBe(false);
		expect(orch.getEvents().some((e) => e.type === "worktree:removed")).toBe(true);
	});
});

describe("untrusted test commands", () => {
	it("approved test command runs post-merge → done", async () => {
		const { orch, repo } = fixture();
		const t = orch.createTask({
			title: "x", role: "frontend-dev",
			spec: { prompt: "do", testCommand: "test -f ui.js" },
		});
		await orch.runTask(t.id);
		await orch.approve(t.id, "cto"); // ConsoleIdeAdapter auto-approves the command
		expect(orch.getTask(t.id)!.verifyApprovedBy).toBe("cto");
		await orch.mergeApproved();
		expect(orch.getTask(t.id)!.status).toBe("done");
		expect(existsSync(join(repo, "ui.js"))).toBe(true);
		const types = orch.getEvents().map((e) => e.type);
		expect(types).toContain("verify:approved");
		expect(types).toContain("verify:passed");
	});

	it("unapproved test command → merge applies, task stays merged, verify skipped", async () => {
		const { repo } = fixture();
		const ide = new ConsoleIdeAdapter().withAnswers({ "post-merge test command": "decline" });
		const orch = orchOver(repo, makeRuntime({}), ide);
		const t = orch.createTask({
			title: "x", role: "frontend-dev",
			spec: { prompt: "do", testCommand: "exit 0" },
		});
		await orch.runTask(t.id);
		await orch.approve(t.id, "cto");
		await orch.mergeApproved();
		const task = orch.getTask(t.id)!;
		expect(task.status).toBe("merged"); // applied but unverified
		expect(existsSync(join(repo, "ui.js"))).toBe(true);
		expect(orch.getEvents().some((e) => e.type === "verify:skipped")).toBe(true);
	});

	it("approveVerification resumes a merged-but-unverified task", async () => {
		const { repo } = fixture();
		const ide = new ConsoleIdeAdapter().withAnswers({ "post-merge test command": "decline" });
		const orch = orchOver(repo, makeRuntime({}), ide);
		const t = orch.createTask({
			title: "x", role: "frontend-dev",
			spec: { prompt: "do", testCommand: "test -f ui.js" },
		});
		await orch.runTask(t.id);
		await orch.approve(t.id, "cto");
		await orch.mergeApproved();
		expect(orch.getTask(t.id)!.status).toBe("merged");
		await orch.approveVerification(t.id, "cto");
		expect(orch.getTask(t.id)!.status).toBe("done");
	});

	it("unsafe test command never executes; task fails at merge", async () => {
		const { orch } = fixture();
		const t = orch.createTask({
			title: "x", role: "frontend-dev",
			spec: { prompt: "do", testCommand: "sudo rm -rf /" },
		});
		await orch.runTask(t.id);
		await orch.approve(t.id, "cto");
		expect(orch.getTask(t.id)!.verifyApprovedBy).toBeUndefined();
		await orch.mergeApproved();
		expect(orch.getTask(t.id)!.status).toBe("failed");
		const skipped = orch.getEvents().find((e) => e.type === "verify:skipped");
		expect(skipped).toBeDefined();
		expect((skipped!.data!.reason as string)).toContain("unsafe");
	});
});

describe("diff completeness", () => {
	it("represents added, modified, deleted and renamed files", async () => {
		const repo = mkdtempSync(join(tmpdir(), "zci-test-"));
		const run = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
		run(["init", "-q"]);
		writeFileSync(join(repo, "README.md"), "# t\n");
		writeFileSync(join(repo, "del.txt"), "d\n");
		writeFileSync(join(repo, "old.txt"), "o\n");
		run(["add", "-A"]);
		run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
		const git = new RealGitAdapter();
		const wt = await git.createWorktree(repo, "diffcheck");
		writeFileSync(join(wt.path, "new.js"), "new\n");
		appendFileSync(join(wt.path, "README.md"), "more\n");
		rmSync(join(wt.path, "del.txt"));
		Bun.spawnSync(["git", "-C", wt.path, "mv", "old.txt", "renamed.txt"]);
		Bun.spawnSync(["git", "-C", wt.path, "add", "-A"]);
		Bun.spawnSync(["git", "-C", wt.path, "-c", "user.email=a@a", "-c", "user.name=a", "commit", "-qm", "work"]);
		const diff = await git.getDiff(wt.path, wt.baseRef);
		const statuses = new Map(diff.changes.map((c) => [c.path, c.status]));
		expect(statuses.get("new.js")).toBe("added");
		expect(statuses.get("README.md")).toBe("modified");
		expect(statuses.get("del.txt")).toBe("deleted");
		expect(statuses.get("renamed.txt")).toBe("renamed");
		expect(diff.patch).toContain("renamed.txt");
	});
});
