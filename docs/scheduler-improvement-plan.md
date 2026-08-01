# Multi-target scheduler improvement plan

Work list for `multi-manager.ts` and its dependencies. Items are ordered by
dependency, not by payoff — later items read values that earlier items correct.
Do them in order.

Two reviews (Claude + Codex) agreed on this list; where they disagreed, the
resolution is recorded inline under **Disagreement resolved**.

## Before you start

Read `CLAUDE.md` and `AGENTS.md` first. The constraints that matter most here:

- **No build step.** `.ts` files in `src/` are pushed verbatim to the game and
  transpiled by Bitburner. Imports must keep their literal `.ts` extension.
  Never rewrite them to `.js` or extensionless.
- **Do not modify `manager.ts` or `worker-*.ts`.** `manager.ts` is the stable
  single-target fallback. The workers are ~400 bytes each precisely because
  script RAM is charged per `ns.*` API _referenced_ — adding one call to a
  worker multiplies the cost of every thread launched.
- **Keep the purity boundary.** `multi-planning.ts` and `multi-scheduler.ts`
  must contain no `ns` access at all; that is what lets `tests/*.mjs` import
  them directly under Node's type-stripping. All Netscript calls go in
  `multi-runtime.ts`.
- **`npm test` and `npm run check` are green and must stay green** (67 tests, 0
  `tsc` errors as of writing). Run both after every item. Run `npm run format`
  before finishing.
- **Bitburner cannot be run here.** Never claim in-game or integration behavior
  was verified. Node tests, `tsc`, and reading code are the only real evidence.
  Items marked _(needs in-game verification)_ must be handed back to the player.

RAM-cost note for new `ns` calls: `ns.getServer`, `ns.ps`, `ns.fileExists`,
`ns.getServerMoneyAvailable` and `ns.getServerSecurityLevel` are **already
referenced** somewhere in the manager's import graph, so using them again costs
nothing additional. Introducing a genuinely new API (e.g. anything under
`ns.formulas.*`) does add RAM to the manager and needs justification.

---

## 1. Correct `timeScale` in `getPreparedMetrics`

**Problem.** `hacking-lib.ts:446` extrapolates prepared-state durations with

```ts
const timeScale = minSecurity / Math.max(minSecurity, currentSecurity);
```

Bitburner's hacking time is **affine** in difficulty, not linear:

```
hackTime = 5 · (2.5 · requiredHackingSkill · hackDifficulty + 500)
           / (hackingSkill + 50) / speedMultipliers
```

The `+ 500` term dominates when `requiredHackingSkill` is small. For a `req = 1`
server going from security 10 → 1 the true scale is ~0.96; the current code
returns 0.10, a ~10× underestimate. For `req = 1000` it is off by ~3.5%.

**Blast radius.** Batch _timing_ is safe: all three durations share the factor,
so intra-batch landing order is preserved, and batches only launch on prepared
targets where the factor is ~1 anyway. The damage is to **ranking** —
`expectedMoneyPerSecond` is inflated ~10× for low-level servers, so they win
both the batch and prep orderings — and to `expectedEndAt`, which drives
`LATE` classification (see item 3).

**Fix.** Replace with the exact ratio. `getPreparedMetrics` already calls
`ns.getServer(host)`; read `requiredHackingSkill` from it.

```ts
const HACK_TIME_DIFF_FACTOR = 2.5;
const HACK_TIME_BASE_DIFF = 500;

function hackTimeScale(
  requiredSkill: number,
  fromSecurity: number,
  toSecurity: number,
): number {
  const at = (security: number) =>
    HACK_TIME_DIFF_FACTOR * requiredSkill * security + HACK_TIME_BASE_DIFF;
  return at(toSecurity) / at(fromSecurity);
}
```

Then `timeScale = hackTimeScale(requiredLevel, currentSecurity, minSecurity)`.
Grow and weaken are fixed multiples of hack time, so the same factor still
applies to all three.

**Testing.** Export `hackTimeScale` from `hacking-lib.ts` (it is pure, so tests
can import it). Cover: `req = 1` low-security case, a high-`req` case where the
old and new formulas nearly agree, `fromSecurity === toSecurity` returning
exactly 1, and a guard for `requiredSkill` being `undefined`/0.

**Acceptance.** `run multi-manager.ts --report` no longer ranks trivial
low-level servers above real targets. _(needs in-game verification)_

---

## 2. Implement the missing commit-time validation

**Problem.** `docs/multi-target-design.md:302-318` specifies eight guards
against stale-state scheduling, and `:329` makes "revalidate target generation
and the exact runner allocation" step 1 of atomic launch. `commitGroup`
(`multi-runtime.ts:291`) implements only the launch-lead margin and the
free-RAM half of guard 6. Missing entirely:

- **Guard 3, generation token.** `targetGeneration` is written into every
  `JobGroup` (`multi-planning.ts:440`) and **never compared to anything**.
- **Guard 5, commit-time target check.** Nothing re-reads money or security
  immediately before the first `exec`.
- **Guard 6, worker availability.** `workersAvailable` is evaluated once at
  snapshot time in `createLedger` and never rechecked before exec.

**Why guard 5 is not redundant with guard 3.** `generation` increments only on
_our own_ accepted observations (`multi-scheduler.ts:207`). A player hacking the
target by hand, a leftover foreign worker, or a recovered process landing an
effect all move the server while leaving the token unchanged. Only a fresh read
catches that class. Implement both.

**Fix.** Keep the purity split:

1. Add a **pure** predicate (in `multi-scheduler.ts`, next to
   `classifyObservation`):

   ```ts
   export function isStillCommittable(input: {
     group: JobGroup;
     currentGeneration: number;
     fresh: Observation;
     config: SchedulerConfig;
   }): { ok: true } | { ok: false; reason: string };
   ```

   It must reject when `group.targetGeneration !== currentGeneration`, and when
   `classifyObservation(fresh, config)` no longer matches the group's purpose:
   `batch` requires `BATCH_READY`, `money-prep` requires `MONEY_PREP_READY`,
   `security-prep` requires `SECURITY_PREP_READY`. Reuse the existing
   `securityTolerance` / `moneyReadyRatio` config — do not invent new tolerances.

2. In `commitGroup`, immediately before the first `exec` and after the existing
   lead/RAM checks: re-read the target with `ns.getServer`, build a fresh
   `Observation`, call the predicate, and abort the whole commit on rejection.
   Also verify worker files still exist on every distinct host in the
   allocation (`home` is exempt, matching `readRunners`).

3. `commitGroup` needs the expected generation. Pass it explicitly as a
   parameter rather than handing the whole `TargetRecord` to the runtime.

A rejection here is a normal outcome, not a failure: return the existing
`{ok: false, reason}` shape so `commitDecision` routes it through
`launch-failed` → `BACKOFF` as it already does. Consider a distinct reason
string so the status line can distinguish "state moved" from "exec failed".

**Testing.** `isStillCommittable` is pure — test generation mismatch, each
purpose/phase mismatch, tolerance boundaries, and the happy path.

---

## 3. Preserve group fault state through receipt pruning

**Problem.** `pruneTerminalReceipts` (`multi-manager.ts:321`, implemented at
`multi-planning.ts:1129`) drops every terminal receipt at the end of each
`reconcileTargets`, and `LOST` is terminal. So when one fragment is lost while
its siblings are still live, the loop hits `owned.some(isLiveStatus) → continue`
without transitioning, then prunes the `LOST` receipt. On the later loop where
the siblings finish, `owned` (`multi-manager.ts:305`) no longer contains it,
`lost` is `false`, and the group closes with `receipts-terminal` instead of
`timing-fault` — **no backoff, loss silently forgotten**.

**Fix.** Give faults a home that outlives receipts.

- Extend `InFlightLedger` to
  `{ receipts: Receipt[]; groupFaults: Record<string, GroupFault> }` with
  `GroupFault = { lost: number; late: number; killed: number; firstFaultAt: number }`.
- Record the fault in `applyReceiptStatus` when a receipt transitions into
  `LOST` / `LATE` / `KILLED`.
- `pruneTerminalReceipts` keeps `groupFaults` untouched.
- `reconcileTargets` reads `groupFaults[record.activeGroupId]` instead of
  scanning `owned` for `LOST`.
- Clear the group's entry once the target has transitioned, so the map cannot
  grow without bound.

Update `createInFlightLedger` and every test that constructs a ledger literal.

**Disagreement resolved — do NOT escalate `LATE` to backoff.** Codex flagged
that `LATE` stays live and then closes as an ordinary terminal status without
triggering a timing fault. Record it and display it, but leave the escalation
path to `LOST` and `KILLED` only. Reasons:

- `LATE` is live (`multi-planning.ts:1066`), so the target lock holds, and the
  mandatory re-observation after the group already catches real drift and routes
  the target to prep. Self-correction works.
- `expectedEndAt` is derived from the same durations item 1 fixes. Before that
  fix, every fragment on a low-`req` server classifies `LATE`, so wiring `LATE`
  to a 5s backoff would penalise exactly the targets whose estimates are worst.

Revisit only after item 1 has been verified in game.

---

## 4. Separate stable sizing capacity from current free RAM

**Problem.** `multi-manager.ts:336` sums `allocatableRam`, which is **free** RAM
(`maxRam − usedRam − reserve`, `multi-planning.ts:358`), and passes it to
`computeEconomics` → `buildPreparedBatch` as `availableRam`. That gates the
sizing loop at `hacking-lib.ts:410`:

```ts
if (ramNeeded > availableRam + 1e-9) continue; // then requestedFraction *= 0.8
```

A scheduler doing its job keeps free RAM near zero, so in steady state every
newly-observed target has its hack fraction ratcheted down — often to the
`0.0025` floor, making `hackThreads` 1. That batch still pays for a grow and two
weakens, and the target is then locked for the whole wave
(`multi-scheduler.ts:276`). Per-GB it is ~30% worse; per _target-lock_ — the
scarce resource in this design — it is far worse. It also corrupts
`expectedMoneyPerSecond`, which item 5 depends on.

**Fix.** Size the batch spec against stable capacity; keep the free-RAM ledger
for actual allocation (unchanged).

**Do not use total physical RAM.** If capacity includes RAM permanently held by
`cloud-manager.ts`, `hacknet-roi.ts`, the manager itself, or anything the player
runs by hand, `buildPreparedBatch` settles on a size that fits physical but can
never fit free RAM. `planLargestWave` then fails at `batchCount = 1` with
`COMPLETE_BATCH_TOO_LARGE` on every pass and that target never batches again —
a worse failure than the leak being fixed.

Define capacity per runner as `maxRam − homeReserve − foreignUsedRam`, where
`foreignUsedRam` is the RAM used by processes whose filename is **not** in
`WORKER_FILES` (our own workers' RAM counts as capacity; it comes back to us).
Compute it in `multi-runtime.ts` with an `ns.ps(host)` sweep on the 15s
infrastructure refresh and cache it in `ManagerState` — not per loop.

**Backstop against stalls.** Track consecutive `COMPLETE_BATCH_TOO_LARGE`
rejections per target. After 3, let that target step its fraction down one
`×0.8` notch; reset on a successful batch commit. Implement as a new
`TargetRecord` field plus a new event in `reduceTarget` (`batch-too-large`
increments, `group-committed` with `purpose: "batch"` resets), so it stays in
the pure reducer.

**Testing.** Capacity arithmetic and the step-down/reset reducer transitions are
both pure — test them. Include a case where foreign RAM exceeds free RAM.

---

## 5. Rank tracked targets with the corrected economics model

**Problem.** `multi-manager.ts:203` picks the tracked set by raw max money:

```ts
.sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a))
.slice(0, config.maxTargets);
```

`rankTargets()` (`hacking-lib.ts:323`) already scores expected $/s under the real
four-operation batch — hack percent, hack chance, weaken time, RAM cost — and is
used by `scout.ts` and `manager.ts` but not here. Max money systematically
favours fat servers with high `minDifficulty` and high `requiredHackingSkill`
over mid-tier servers that cycle much faster.

**Fix.** Select the tracked set with `rankTargets`, priced against the stable
capacity from item 4 (not free RAM). Preserve the existing rule that a target
with work in flight is never dropped from tracking. Runs on the 15s refresh, so
the extra `ns` calls (~8–10 per money server) are affordable; do not move it
into the per-loop path.

**Depends on:** items 1 and 4 — both feed the numbers this ranks on.

---

## 6. Bounded multi-commit refill loop

**Problem.** `main` calls `decide()` once per iteration, commits, then sleeps
200–1000ms (`multi-manager.ts:138-151`). After a wave drains, filling N targets
takes N loops — up to 8 seconds at `--targets 8` — with freed RAM unallocated
the whole time.

**Fix.** After a successful commit, re-read runners, re-run `decide`, and commit
again; stop on `idle`, on a commit cap (default ~4), or on a wall-clock budget.

**Critical detail:** recompute `now = Date.now()` on every refill iteration and
pass it to both `decide` and the group's `plannedAt`. Reusing the loop's
original `now` makes skew accumulate across commits and will start tripping the
launch-lead margin check in `commitGroup`.

The wall-clock budget matters for the same reason — the refill loop lengthens
the plan→exec window, which is exactly why item 2 comes first.

Committing a group already makes its target ineligible for the next `decide()`,
so no additional guard against double-scheduling is needed.

---

## 7. Reduce per-loop Netscript and allocation overhead

`commitGroup` aborts when planning consumes more than
`launchLead − launchSafetyMs` (750ms at defaults), and a failure costs a 5s
backoff. This work is what makes lowering `--lead` safe later.

- **`readRunners` (`multi-runtime.ts:141`)** does
  `files.every(file => ns.fileExists(file, host))` — 3 `fileExists` per host,
  every loop. `workersAvailable` only changes when `deployWorkers` runs; cache
  it as a `Set` on the infrastructure refresh and pass it in.
- **`pollReceipts` (`multi-runtime.ts:376`)** calls `ns.isRunning` on every live
  receipt every loop; eight targets running 20-batch waves is easily 600–1500
  receipts. Skip receipts whose `expectedEndAt` has not passed — they cannot
  have finished. Keep a full sweep on a slower cadence (~2s) so early-`LOST`
  detection survives.
- **`allocateJobs` (`multi-planning.ts:731`)** re-sorts the whole host list
  inside the per-job loop. Only one entry changes per placement, so maintain the
  sorted array and re-insert.

**This optimisation must be behaviour-preserving.** Placement order affects
which host gets which fragment. Keep the `home`-last rule and every tie-break
(`compareHostsForPlacement`) byte-identical, and add a test asserting identical
allocations for a fixed input before and after.

---

## 8. Improve prep behaviour

- **Combined prep.** `classifyObservation` checks security first, so a fresh
  target pays weaken-cycle → settle → observe → grow-cycle → settle → observe
  before earning anything. A single group of grow plus a weaken sized to clear
  _both_ the existing security excess _and_ the grow's own increase roughly
  halves that ramp. The invariant "money prep never ships grow without its
  compensating weaken" still holds — this is a superset, not an exception.
- **Grow safety margin.** `growThreads` comes from an extrapolated
  `growthAnalyze` (`growthThreadsAtSecurity`, `hacking-lib.ts:463`). A slight
  undershoot drops money below `moneyReadyRatio` (0.999) and costs a full prep
  cycle. Add a configurable margin (~2%) — cheap insurance against an expensive
  outcome.
- **Split-grow under-delivery.** Grow fragments land in exec order and each
  raises difficulty for the next, so a large split grow under-grows. Either
  chunk grow with per-chunk weakens or document the behaviour and let the
  re-prep cycle absorb it. Lowest priority in this item.
- **Security-100 dead zone.** `getPreparedMetrics` returns `null` when
  `currentSecurity >= 100` (`hacking-lib.ts:439`), so a server wrecked to max
  security scores $0/s and sinks to the bottom of the prep queue exactly when it
  most needs prep; only `prepAgingMs` rescues it. Give such targets a prep
  priority that does not depend on a batch model that cannot be built.

---

## 9. Continuous wave chaining — design change, do last

**Do not start this until items 2 and 3 are done and verified.** It is the only
item that changes the accepted design, and it depends on generation tokens
actually being enforced.

**Problem.** `planBatchGroup` (`multi-planning.ts:453`) execs all batches
immediately with escalating `additionalMsec`, so the last batch's threads hold
RAM from t=0 while landing much later; and the target stays locked until every
receipt is terminal, then pays settle → re-observe → re-decide before the next
wave. Money per RAM-second is roughly `E / ((W + 4·gap·n) · batchRam)` versus
`E / (W · batchRam)` for continuous batching — about 1.8× at `W`=20s,
`gap`=200ms, `n`=20, and closer to 2.3× once the inter-wave gap is counted.

**The design argument.** `docs/multi-target-design.md` forbids scheduling from
predicted state, but the rule is already bent internally: batch #2's hack
assumes batch #1's grow restored the money. The invariant relied on is "a
complete H/W1/G/W2 batch returns the server to prepared," and that is equally
true across a wave boundary as within one. Chaining a follow-on wave —
scheduled to land after the last in-flight landing, verified by re-observation
on completion, repaired via prep if it drifted — is the standard
assume/verify/repair loop, not a new category of risk.

**Process requirement.** Amend `docs/multi-target-design.md` first, with the
revised invariant written down, then implement. Do not silently diverge from the
spec.

---

## Tuning knobs — no code change _(needs in-game verification)_

Hand these back to the player rather than changing defaults blind. Several
interact with the items above and should be retested after them.

- `--lead 1000` adds a flat 1s to every group; try 400–500 **after item 7**.
- `--gap 200` is conservative. Workers align to a shared `plannedAt` and
  self-correct for skew, so 50–100ms is plausible and directly shrinks wave
  spread and RAM hold.
- `--batches 20` caps wave size; raising it helps only while waves stay short —
  otherwise it makes the item 9 problem worse.
- `--targets 8` is likely low once real RAM exists, and matters more after
  item 5.
- `--hack 0.10`: lower fractions are more RAM-efficient because grow threads
  scale super-linearly, but only pay off once the batch cap is not binding.

## Definition of done for each item

1. `npm test` passes, with new tests covering the pure logic the item added.
2. `npm run check` reports zero errors.
3. `npm run format` has been run.
4. `src/README.txt` updated if any flag or usage changed.
5. No changes to `manager.ts` or `worker-*.ts`.
6. Behaviour claims in the summary are limited to what Node tests and type
   checking actually prove.
