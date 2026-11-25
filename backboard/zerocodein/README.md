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
bun test tests/          # 13 tests: states, deps, worktrees, parallel, approvals
bun run typecheck
bun run demo/e2e-demo.ts # full idea → plan → arch → parallel dev → merge → test
```
