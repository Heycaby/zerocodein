// ZeroCodeIn Phase 1 e2e demo — full idea → code workflow in one sitting.
// Uses FakeRuntime (zero model cost) + RealGitAdapter: every other step is real.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { RealGitAdapter } from "../src/adapters/git.ts";
import { FakeRuntime } from "../src/adapters/runtime.ts";
import { ConfigModelProvider, DEFAULT_PROVIDER_CONFIG } from "../src/adapters/providers.ts";
import { ConsoleIdeAdapter } from "../src/adapters/ide.ts";
import { ExecutionAdapterImpl } from "../src/adapters/execution.ts";
import type { SessionSpec } from "../src/adapters/contracts.ts";

const idea = "a minimal notes app with a UI and a save API";

const repo = mkdtempSync(join(tmpdir(), "zci-demo-"));
const g = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
g(["init", "-q"]);
writeFileSync(join(repo, "README.md"), "# demo project\n");
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
g(["add", "-A"]);
g(["-c", "user.email=demo@zci", "-c", "user.name=demo", "commit", "-qm", "init"]);

const runtime = new FakeRuntime({
	"pm": async function* (spec: SessionSpec) {
		writeFileSync(join(spec.worktreePath, "PLAN.md"),
			"# Plan\n- Notes list UI\n- POST /notes save API\n- File-backed store\n");
		yield { type: "tool:result", toolName: "Write", output: "wrote PLAN.md" };
	},
	"architect": async function* (spec: SessionSpec) {
		writeFileSync(join(spec.worktreePath, "ARCHITECTURE.md"),
			"# Architecture\nui.js renders notes; api.js saves to notes.json.\n");
		writeFileSync(join(spec.worktreePath, "TASKS.json"), JSON.stringify([
			{ id: "ui", title: "Notes list UI", role: "frontend-dev",
			  prompt: "Create ui.js exporting renderNotes(notes) returning HTML string.",
			  dependsOn: [] },
			{ id: "api", title: "Save API", role: "backend-dev",
			  prompt: "Create api.js exporting saveNote(note) writing notes.json.",
			  dependsOn: [] },
		]));
		yield { type: "tool:result", toolName: "Write", output: "wrote ARCHITECTURE.md + TASKS.json" };
	},
	"frontend-dev": async function* (spec: SessionSpec) {
		writeFileSync(join(spec.worktreePath, "ui.js"),
			"export function renderNotes(notes) {\n  return `<ul>${notes.map(n => `<li>${n}</li>`).join(\"\")}</ul>`;\n}\n");
		yield { type: "tool:result", toolName: "Write", output: "wrote ui.js" };
	},
	"backend-dev": async function* (spec: SessionSpec) {
		writeFileSync(join(spec.worktreePath, "api.js"),
			"import { writeFileSync, readFileSync, existsSync } from 'node:fs';\n" +
			"export function saveNote(note, file = 'notes.json') {\n" +
			"  const notes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];\n" +
			"  notes.push(note); writeFileSync(file, JSON.stringify(notes));\n  return notes.length;\n}\n");
		yield { type: "tool:result", toolName: "Write", output: "wrote api.js" };
	},
});

const orch = new Orchestrator({
	repoPath: repo,
	git: new RealGitAdapter(),
	runtime,
	providers: new ConfigModelProvider(DEFAULT_PROVIDER_CONFIG),
	ide: new ConsoleIdeAdapter(),
	execution: new ExecutionAdapterImpl(runtime),
	sink: (e) => console.log(`  · [${e.type}]${e.taskId ? " " + e.taskId : ""}`),
});

console.log("═══ ZeroCodeIn e2e demo ═══");
console.log(`repo: ${repo}\n`);

console.log("1. submit idea →");
const pm = await orch.submitIdea(idea);
console.log(`   PM status: ${pm.status}`);

console.log("2. approve plan →");
const arch = await orch.approvePlan(pm.id, "demo-user");
console.log(`   Architect status: ${arch.status}`);

console.log("3. materialize task graph →");
const devs = await orch.materializeGraph(arch.id);
console.log(`   dev tasks: ${devs.map((d) => `${d.id}(${d.role})`).join(", ")}`);

console.log("4. approve architecture → devs can start (merge still pending) →");
await orch.approve(arch.id, "demo-user");
await orch.runReadyTasks();
for (const d of devs) {
	const t = orch.getTask(d.id)!;
	console.log(`   ${t.id}: ${t.status} @ ${t.worktreePath}`);
}

console.log("5. review + approve dev diffs →");
for (const d of devs) await orch.approve(d.id, "demo-user");

console.log("6. merge approved work →");
await orch.mergeApproved();
for (const d of devs) console.log(`   ${d.id}: ${orch.getTask(d.id)!.status}`);

console.log("7. verify merged output →");
const ok = existsSync(join(repo, "ui.js")) && existsSync(join(repo, "api.js"));
console.log(`   files in parent: ui.js=${existsSync(join(repo, "ui.js"))} api.js=${existsSync(join(repo, "api.js"))}`);
const test = Bun.spawnSync(["node", "--input-type=module", "-e",
	`import { renderNotes } from './ui.js'; import { saveNote } from './api.js';
	 const n = saveNote('hello'); if (n !== 1) throw 1;
	 if (!renderNotes(['hello']).includes('hello')) throw 2;
	 console.log('   TEST PASS: saveNote + renderNotes work in parent repo');`], { cwd: repo });
console.log(test.stdout.toString().trim() || `   TEST FAIL: ${test.stderr.toString()}`);

console.log(`\nevents recorded: ${orch.getEvents().length}`);
const branch = g(["branch", "--show-current"]).stdout.toString().trim();
console.log(`parent branch '${branch}' received merges only via git adapter: ${ok}`);
