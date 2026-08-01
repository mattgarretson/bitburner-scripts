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
sweep: 67 tests passing across `tests/multi-planning.test.mjs`,
`tests/multi-scheduler.test.mjs`, and `tests/multi-runtime.test.mjs`, and zero `tsc`
errors under `"strict": true`.

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

## Architecture

### Orchestration / calculation split

`manager.ts` is the single-target HGW manager and is deliberately kept as a readable event
loop: refresh infrastructure → pick target → weaken to min security → grow to max money →
launch the largest complete batch wave that fits. It contains no allocation math.

`hacking-lib.ts` holds everything else: network scan/root/deploy, runner discovery,
target inspection and ranking, batch sizing, RAM allocation, and atomic launch. Keep this
boundary — calculations go in the library, sequencing goes in the manager.

### The worker contract

All three workers take the same positional args and perform exactly one operation:

```
[target, requestedDelay, plannedAt, groupOrBatchId, label]
```

Each worker subtracts launch skew (`Date.now() - plannedAt`) from `requestedDelay` and
passes the remainder as `additionalMsec`, so a slow `ns.exec` sequence doesn't smear the
H/W/G/W landing order. Args 3 and 4 are informational today — they exist so a scheduler
can tag and later recover its own processes without changing worker behavior.

### Plan-then-launch

Nothing is executed until a whole logical unit is allocated. `allocateJobs()` allocates
against a **private RAM ledger** copied from live free RAM, so a non-null return means
every thread of every job has a home; `null` means at least one didn't fit and nothing was
touched. `launchAtomic()` then execs in delay order and kills every already-launched PID if
any `ns.exec` returns 0. Wave and prep sizing (`planLargestWave`, `planMoneyPrep`) binary-search
the largest size that allocates.

A wave is only ever shrunk by whole batches. A batch is H + W1 + G + W2; never drop an
operation or a compensating weaken to make something fit. Money prep is always grow plus
its weaken.

`config.homeReserve` is subtracted from `home`'s free RAM in `freeRam()` before any
planning, so it must not be circumvented anywhere.

### Batch model details worth knowing before editing `hacking-lib.ts`

- `getPreparedMetrics()` extrapolates hack percent/chance and H/G/W durations from the
  target's *current* security to its *minimum* security, because targets are batched only
  once prepared. `growthThreadsAtSecurity()` similarly rescales `ns.growthAnalyze()` (which
  answers for current security) using the game's adjusted growth log constants.
- `weakenThreadsForGrow()` deliberately omits the hostname argument to
  `ns.growthAnalyzeSecurity` — passing it caps the result against the target's *current*
  money, which is wrong when planning growth that happens after a future hack.
- `rankTargets()` scores expected dollars/second under the manager's real four-operation
  batch, priced against currently free RAM — not a generic max-money/weaken-time heuristic.
  `scout.ts` and `manager.ts --report` render the same model.

## In-progress work: the multi-target scheduler

`docs/multi-target-design.md` is the accepted design for a multi-target scheduler and is
the spec to follow for that work. `docs/scheduler-improvement-plan.md` is the current
ordered work list against that scheduler — dependency-ordered, so do its items in order.

Load-bearing rules from the design doc and from `AGENTS.md`:

- **Do not modify `manager.ts` or the workers** while building it — `manager.ts` stays as
  the stable single-target fallback. New code goes in `multi-manager.ts` (loop + status),
  `multi-runtime.ts` (all `ns` reads/exec/kill), `multi-planning.ts` (pure allocation and
  timing), `multi-scheduler.ts` (pure target reducer/policy).
- `multi-manager.ts` must detect a running `manager.ts` or a second `multi-manager.ts`,
  report `CONFLICTING_MANAGER`, and launch nothing. It must never kill the fallback.
- Never schedule from predicted state. A target returns to `NEEDS_OBSERVATION` after any
  group ends; generation tokens invalidate plans built from a stale observation.
- Complete profitable batches are considered before prep; prep may only use RAM the batch
  pass left idle, and never delays a batch window that is already known to be ready.
- Every unallocated chunk of usable RAM needs a structured, displayable reason (see the
  idle reason-code table in the design doc).
- Pure planning/scheduling logic must have Node tests. Timing, PID lifecycle, SCP behavior,
  and real hack/grow/weaken effects can only be validated manually in-game.

## Other scripts

`scout.ts` (target report), `cloud-manager.ts` (buys/upgrades `ns.cloud` servers by lowest
$/GB), `hacknet-roi.ts` (buys the shortest-payback Hacknet upgrade; refuses BN9 hash mode),
`path.ts` (connect path to a host), `find-contracts.ts`, `stop-hacking.ts` (kills the
manager and all workers network-wide — run before replacing the suite).

`src/README.txt` is the in-game user-facing quick reference and ships to `home` with the
scripts; keep it in sync when flags or usage change.
