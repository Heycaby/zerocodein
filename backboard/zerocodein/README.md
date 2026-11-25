# zerocodein

ZeroCodeIn orchestration layer — an **additive** package on the Backboard fork.
No upstream internals are modified; all new code lives here.

## What it is

The central orchestration foundation: task state, dependencies, agent
assignments, approvals, and lifecycle for the four-agent MVP
(PM / Architect / Frontend Dev / Backend Dev).

## Source-of-truth split (hard rule)

- **Orchestrator** owns task state, dependencies, assignments, approvals, lifecycle.
- **Git** owns repository content — all repo writes go through the A4 Git adapter.
- Agents only ever see worktree paths, never the parent repo.

## Five adapter contracts (`src/adapters/contracts.ts`)

| Adapter | Contract | Implementations |
|---|---|---|
| A1 agent runtime | sessions, events | `CliTsRuntime` (drives `cli-ts --print`), `FakeRuntime` (tests) |
| A2 model provider | task-class → model | `ConfigModelProvider` |
| A3 IDE | notify/diff/ask | `ConsoleIdeAdapter` |
| A4 git | worktrees, diffs, merges | `RealGitAdapter` |
| A5 execution | local/cloud dispatch | `ExecutionAdapterImpl` (local; cloud stubbed) |

## Run

```bash
bun install
bun test tests/          # unit tests: states, deps, worktrees, sessions, models, approvals
bun run typecheck
bun run demo/e2e-demo.ts # full idea → plan → arch → parallel dev → merge → test
```

## Untrusted agent output

- Agent-supplied `testCommand`s are untrusted input. They are validated
  (`testCommandError` rejects unsafe constructs) and require explicit user
  approval — via `approve()`'s IDE prompt or `approveVerification()` — before
  the orchestrator will execute them. Unapproved commands skip verification;
  the task stays `merged` until approved or rejected.
- Review diffs list every change: added, modified, deleted and renamed files
  (`DiffSummary.changes`, rename-aware via `git diff -M`).

## Known limitation: in-memory persistence

Task state (`tasks`), session handles and the event log currently live only in
process memory. A crash or restart loses orchestrator state — worktrees and
commits survive in git, but the task graph must be rebuilt.

**Proposed design (pre-production):** event-sourced journal. Every
`OrchestratorEvent` is already structured and ordered (`seq`) — append it to
`.zci/orchestrator.log` (JSONL) inside the repo. On boot, replay the journal to
rebuild the task map; sessions and worktrees are rehydrated from recorded
`worktree:created`/`agent:assigned` events. Git remains authoritative for repo
content, so replay only reconstructs orchestration views — never repo state.
Snapshots can compact the log periodically. No external DB is needed for the
local MVP; the journal file also gives every agent action a durable audit trail.
