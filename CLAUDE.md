# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Netscript automation scripts for **Bitburner 3.0.2**, written in **TypeScript**. There is
no build step: `.ts` files in `src/` are pushed verbatim to the in-game `home` server by
`bitburner-filesync` over the Remote File API (port 12525, `filesync.json`), and Bitburner
transpiles them itself. What you edit is what runs in the game — `tsc` is only ever used
for `--noEmit` type checking.

Claude cannot run Bitburner. Never claim in-game/integration behavior was tested — only
Node tests, type checking, and reading code are actually verifiable here.

## Commands

```
npm run sync          # start bitburner-filesync; pushes src/ to home while the game is connected
npm test              # node --test
npm run check         # tsc --noEmit
npm run format        # prettier --write src/ tests/
npm run format:check
```

Single test file: `node --test tests/<name>.test.mjs`. Single test by name:
`node --test --test-name-pattern "<regex>"`.

**Both `npm test` and `npm run check` are green and must stay that way.** As of the last
sweep: 95 tests passing across `tests/hacking-lib.test.mjs`,
`tests/multi-planning.test.mjs`, `tests/multi-scheduler.test.mjs`, and
`tests/multi-runtime.test.mjs`, and zero `tsc` errors under `"strict": true`.

Tests are plain `.mjs` importing the `.ts` sources directly — Node's type-stripping runs
them without a build step, which is why the pure modules must stay free of any `ns` import.
`tsconfig.json` includes `tests/**`, so test files are type-checked too.

## Netscript constraints that shape the code

- Every runnable script exports `export async function main(ns: NS)`. Imports must be
  relative with an explicit `.ts` extension (`from "./hacking-lib.ts"`) — the game resolves
  these as literal file paths on `home`, so path/extension changes break running scripts.
  Do **not** let an editor or tool rewrite these to extensionless or `.js` specifiers.
  `allowImportingTsExtensions` in `tsconfig.json` is what keeps `tsc` happy with this.
- Script RAM cost is charged for every `ns.*` API *referenced* in a file, whether called or
  not. This is why `worker-hack.ts` / `worker-grow.ts` / `worker-weaken.ts` are ~400-byte
  files that touch exactly one API each: adding any other `ns` call to a worker multiplies
  the RAM cost of every thread the manager launches.
- `types/NetScriptDefinitions.d.ts` is **generated** — filesync overwrites it from the
  running game (`definitionFile.update: true`). Never hand-edit it. `types/globals.d.ts`
  is the small hand-written file that exposes `NS` as an ambient global type, which is why
  sources annotate `ns: NS` without importing anything.
- Types are erased, not checked, at runtime: Bitburner strips them, and so does Node when
  the `.mjs` tests import a `.ts` module. Never rely on a type for a runtime guarantee, and
  keep type-only imports under `import type { ... }` so nothing extra is pulled in.
- Bitburner 3.x moved purchased-server APIs under `ns.cloud.*` and formatting under
  `ns.format.*`. Older Netscript snippets found online will use the pre-3.x names.

## Code style

Write for a person reading the file top to bottom. Prettier owns layout
(`npm run format`); these rules are about structure. `src/singularity/workout.ts` is the
reference example of a small script written this way.

- **`main` reads like a description of the script.** Keep it to the high-level steps and
  move each step into a small named function declared below it. Nested loops, inline state
  checks, or a tracking flag in `main` usually mean a helper is missing.
- **Names say what the thing means.** `CONSTANT_CASE` module constants, `UpperCamelCase`
  types, `lowerCamelCase` functions. Predicates read as questions (`isWorkingOut`), actions
  as verbs (`startWorkout`).
- **Named functions are function declarations**, not arrow-function constants, with
  explicit parameter and return types.
- **Guard clauses over nesting:** `if (done) continue;` or an early `return` first, then
  the main path unindented.
- **Comments:** a short `/** JSDoc */` on a helper saying what it does; `//` only for *why*
  a line exists (a game quirk, a non-obvious ordering). Don't narrate what the code already
  says. Every script keeps the header block used across `src/`: `path — one-line summary`,
  behaviour notes, `Usage: run ...`, `@param {NS} ns`.
- **New scripts take their tunables as constants at the top of the file**, not as flags or
  arguments.
- **Lookup tables are `as const` arrays or objects**, with types derived from them
  (`type Stat = (typeof STATS)[number]`) rather than a hand-written union kept in sync.
  Plain string literals are fine for game names — `tsc` checks them against the generated
  definitions.
- **Failures in runnable scripts go to the terminal, not exceptions.** Print the problem
  with `ns.tprint` and end the script; do not `throw` for an expected failure. When the
  failure is detected below `main`, use a small `fail(ns, message): never` helper
  (`ns.tprint` then `ns.exit()`, which costs 0 GB) instead of passing `false` back up
  through every caller. Pure modules are different: they return structured results
  (`ok: false` plus a reason), as described under Plan-then-launch.

## Architecture

### Module split

`multi-manager.ts` is the multi-target HGW scheduler and the only hacking manager. It is
kept as a readable event loop: refresh infrastructure → reconcile receipts → observe
quiescent targets → snapshot runners → ask for one decision → commit it → render → sleep.
It contains no allocation math. The work is split across:

- `multi-runtime.ts` — every `ns` read, exec, kill and PID poll for the scheduler.
- `multi-planning.ts` — pure job timing, RAM allocation, and in-flight receipt accounting.
- `multi-scheduler.ts` — pure per-target reducer and the `decide()` policy.
- `hacking-lib.ts` — shared `ns` helpers: network scan/root/deploy, worker costs, target
  inspection, and the prepared-batch model (`buildPreparedBatch`, `rankTargets`).

Keep the purity boundary: `multi-planning.ts` and `multi-scheduler.ts` must contain no `ns`
access, which is what lets the Node tests import them directly.

### The worker contract

All three workers take the same positional args and perform exactly one operation:

```
[target, requestedDelay, plannedAt, groupOrBatchId, label]
```

Each worker subtracts launch skew (`Date.now() - plannedAt`) from `requestedDelay` and
passes the remainder as `additionalMsec`, so a slow `ns.exec` sequence doesn't smear the
H/W/G/W landing order. Arg 3 carries the scheduler's `mm-` group tag, which is how
`recoverTaggedProcesses()` finds its own workers after a restart.

### Plan-then-launch

Nothing is executed until a whole logical unit is allocated. `allocateJobs()` in
`multi-planning.ts` allocates against a **private copy of the RAM ledger**, so `ok: true`
means every thread of every job has a home; `ok: false` carries a structured rejection and
nothing was touched. `commitGroup()` in `multi-runtime.ts` re-checks live RAM and target
state, execs in delay order, and kills every already-launched PID if any `ns.exec` returns
0. Wave and prep sizing (`planLargestWave`, `planLargestMoneyPrep`,
`planLargestSecurityPrep`) binary-search the largest size that allocates.

A wave is only ever shrunk by whole batches. A batch is H + W1 + G + W2; never drop an
operation or a compensating weaken to make something fit. Money prep is always grow plus
its weaken.

`config.homeReserve` is subtracted from `home`'s RAM in `snapshotRunners()` before any
planning, so it must not be circumvented anywhere.

### Batch model details worth knowing before editing `hacking-lib.ts`

- `getPreparedMetrics()` extrapolates hack percent/chance and H/G/W durations from the
  target's *current* security to its *minimum* security, because targets are batched only
  once prepared. `growthThreadsAtSecurity()` similarly rescales `ns.growthAnalyze()` (which
  answers for current security) using the game's adjusted growth log constants.
- `weakenThreadsForGrow()` deliberately omits the hostname argument to
  `ns.growthAnalyzeSecurity` — passing it caps the result against the target's *current*
  money, which is wrong when planning growth that happens after a future hack.
- `rankTargets()` scores expected dollars/second under a real four-operation batch, priced
  against the given RAM — not a generic max-money/weaken-time heuristic.

## Scheduler rules

`docs/multi-target-design.md` is the accepted design for the scheduler.
`docs/scheduler-improvement-plan.md` is the ordered work list against it —
dependency-ordered, so do its items in order. Both predate the removal of the old
single-target `manager.ts`; ignore their references to it.

- **Do not modify the workers** — see the RAM-cost note above.
- `multi-manager.ts` must detect a second running copy of itself, report
  `CONFLICTING_MANAGER`, and launch nothing. It must never kill the other copy.
- Never schedule from predicted state. A target returns to `NEEDS_OBSERVATION` after any
  group ends; generation tokens invalidate plans built from a stale observation.
- Complete profitable batches are considered before prep; prep may only use RAM the batch
  pass left idle, and never delays a batch window that is already known to be ready.
- Every unallocated chunk of usable RAM needs a structured, displayable reason (see the
  idle reason-code table in the design doc).
- Pure planning/scheduling logic must have Node tests. Timing, PID lifecycle, SCP behavior,
  and real hack/grow/weaken effects can only be validated manually in-game.

## Other scripts

`cloud-manager.ts` (buys/upgrades `ns.cloud` servers by lowest
$/GB until all are at the ceiling, then exits),
`xp-farm.ts` / `xp-grow.ts` (grow loop for hacking XP), `path.ts`
(connect path to a host), `stop-hacking.ts` (kills the manager and all
workers network-wide — run before replacing the suite).

`src/singularity/` holds Singularity-API scripts (`buy-programs.ts`, `backdoor.ts`);
they import shared code as `../hacking-lib.ts`, so any script name they pass to
Netscript must include the folder.

`src/README.txt` is the in-game user-facing quick reference and ships to `home` with the
scripts; keep it in sync when flags or usage change.
