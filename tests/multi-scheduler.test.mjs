import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  IDLE_REASON,
  RECEIPT_STATUS,
  allocateJobs,
  createInFlightLedger,
  createLedger,
  planBatchGroup,
  publishGroup,
  requiredUnits,
  snapshotRunners,
} from "../src/multi-planning.ts";

import {
  PHASE,
  batchWindowGuard,
  canRefill,
  checkEligibility,
  classifyObservation,
  continuationWindow,
  createTargetRecord,
  decide,
  isStillCommittable,
  preparedPrepPriority,
  reduceTarget,
} from "../src/multi-scheduler.ts";

const WORKERS = {
  hack: { file: "worker-hack.ts", ram: 1.7 },
  grow: { file: "worker-grow.ts", ram: 1.75 },
  weaken: { file: "worker-weaken.ts", ram: 1.75 },
};

const CONFIG = {
  ...DEFAULT_CONFIG,
  homeReserve: 8,
  landingGap: 200,
  launchLead: 1000,
};

const NOW = 1_000_000;

test("refill limits enforce both the commit cap and wall-clock budget", () => {
  assert.equal(
    canRefill({
      commits: 3,
      elapsedMs: 499,
      commitCap: 4,
      wallClockBudgetMs: 500,
    }),
    true,
  );
  assert.equal(
    canRefill({
      commits: 4,
      elapsedMs: 100,
      commitCap: 4,
      wallClockBudgetMs: 500,
    }),
    false,
  );
  assert.equal(
    canRefill({
      commits: 1,
      elapsedMs: 500,
      commitCap: 4,
      wallClockBudgetMs: 500,
    }),
    false,
  );
});

test("prep priority has a fallback when no prepared batch can be built", () => {
  assert.equal(preparedPrepPriority(0, 1_000_000, 20_000), 50_000);
  assert.equal(preparedPrepPriority(123, 1_000_000, 20_000), 123);
});

/** 4875 units per batch. */
const SMALL_BATCH = {
  hackThreads: 5,
  growThreads: 20,
  weakenHackThreads: 1,
  weakenGrowThreads: 2,
  hackTime: 1000,
  growTime: 2000,
  weakenTime: 4000,
  expectedMoney: 1_000_000,
};

/** 195000 units — deliberately far too large to ever fit. */
const HUGE_BATCH = {
  ...SMALL_BATCH,
  hackThreads: 200,
  growThreads: 800,
  weakenHackThreads: 40,
  weakenGrowThreads: 80,
};

/** 10 grow needs ceil(10*0.004/0.05) = 1 weaken: 11*175 = 1925 units. */
const MONEY_PREP = {
  growThreadsNeeded: 10,
  growSecurityPerThread: 0.004,
  weakenPerThread: 0.05,
  growTime: 2000,
  weakenTime: 4000,
};

/** 5*170 + 30*175 + 4*175 = 6800 units: just above a 60 GB runner. */
const MEDIUM_BATCH = {
  ...SMALL_BATCH,
  hackThreads: 5,
  growThreads: 30,
  weakenHackThreads: 1,
  weakenGrowThreads: 3,
};

function observation(overrides = {}) {
  return {
    valid: true,
    observedAt: NOW,
    money: 1_000_000,
    maxMoney: 1_000_000,
    security: 1,
    minSecurity: 1,
    hackTime: 1000,
    growTime: 2000,
    weakenTime: 4000,
    ...overrides,
  };
}

function batchReady(host, rate, batch = SMALL_BATCH) {
  return {
    ...createTargetRecord(host),
    phase: PHASE.BATCH_READY,
    generation: 1,
    observation: observation(),
    economics: { preparedBatch: batch, expectedMoneyPerSecond: rate },
    waitingSince: NOW,
  };
}

function moneyPrepReady(host, rate, waitingSince = NOW) {
  return {
    ...createTargetRecord(host),
    phase: PHASE.MONEY_PREP_READY,
    generation: 1,
    observation: observation({ money: 1000 }),
    economics: {
      preparedBatch: SMALL_BATCH,
      expectedMoneyPerSecond: rate,
      moneyPrep: MONEY_PREP,
    },
    waitingSince,
  };
}

function securityPrepReady(host, rate) {
  return {
    ...createTargetRecord(host),
    phase: PHASE.SECURITY_PREP_READY,
    generation: 1,
    observation: observation({ security: 20 }),
    economics: {
      preparedBatch: SMALL_BATCH,
      expectedMoneyPerSecond: rate,
      securityPrep: { threadsNeeded: 8, weakenTime: 4000 },
    },
    waitingSince: NOW,
  };
}

function snapshots(runners) {
  return snapshotRunners(runners, CONFIG);
}

function run(targets, runners, extra = {}) {
  return decide({
    targets,
    snapshots: snapshots(runners),
    inFlight: createInFlightLedger(),
    workers: WORKERS,
    config: CONFIG,
    now: NOW,
    serial: 1,
    ...extra,
  });
}

// -----------------------------------------------------------------------------
// Classification and the reducer
// -----------------------------------------------------------------------------

test("observations classify into the three ready phases", () => {
  assert.equal(classifyObservation(observation(), CONFIG), PHASE.BATCH_READY);
  assert.equal(
    classifyObservation(observation({ security: 20 }), CONFIG),
    PHASE.SECURITY_PREP_READY,
  );
  assert.equal(
    classifyObservation(observation({ money: 10 }), CONFIG),
    PHASE.MONEY_PREP_READY,
  );
  assert.equal(
    classifyObservation(observation({ valid: false }), CONFIG),
    PHASE.UNAVAILABLE,
  );
});

function committableGroup(purpose, generation = 2) {
  return {
    id: "group",
    purpose,
    target: "n00dles",
    targetGeneration: generation,
    plannedAt: NOW,
    jobs: [],
    batchCount: purpose === "batch" ? 1 : 0,
    expectedValue: 0,
    expectedLastEndAt: NOW,
    continuation: false,
  };
}

test("commit validation rejects a generation mismatch", () => {
  const result = isStillCommittable({
    group: committableGroup("batch"),
    currentGeneration: 3,
    fresh: observation(),
    config: CONFIG,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /generation moved/);
});

test("commit validation requires the phase matching each group purpose", () => {
  const cases = [
    ["batch", observation({ money: 10 })],
    ["money-prep", observation()],
    ["security-prep", observation({ money: 10 })],
  ];

  for (const [purpose, fresh] of cases) {
    const result = isStillCommittable({
      group: committableGroup(purpose),
      currentGeneration: 2,
      fresh,
      config: CONFIG,
    });
    assert.equal(result.ok, false, purpose);
    assert.match(result.reason, /target state moved/, purpose);
  }
});

test("commit validation uses the existing readiness tolerance boundaries", () => {
  const atBoundary = observation({
    money: 999_000,
    security: 1 + CONFIG.securityTolerance,
  });
  const result = isStillCommittable({
    group: committableGroup("batch"),
    currentGeneration: 2,
    fresh: atBoundary,
    config: CONFIG,
  });
  assert.deepEqual(result, { ok: true });
});

test("commit validation accepts matching batch and prep phases", () => {
  const cases = [
    ["batch", observation()],
    ["money-prep", observation({ money: 10 })],
    ["security-prep", observation({ security: 20 })],
  ];

  for (const [purpose, fresh] of cases) {
    assert.deepEqual(
      isStillCommittable({
        group: committableGroup(purpose),
        currentGeneration: 2,
        fresh,
        config: CONFIG,
      }),
      { ok: true },
      purpose,
    );
  }
});

test("a fresh observation increments the generation", () => {
  const record = createTargetRecord("n00dles");
  const next = reduceTarget(
    record,
    { type: "observed", observation: observation(), now: NOW },
    CONFIG,
  );

  assert.equal(next.generation, 1);
  assert.equal(next.phase, PHASE.BATCH_READY);
  assert.notEqual(next, record, "reducer must not mutate");
  assert.equal(record.generation, 0);
});

test("three complete-batch shortages step sizing down and a batch commit resets it", () => {
  let record = batchReady("n00dles", 100);

  record = reduceTarget(record, { type: "batch-too-large", now: NOW }, CONFIG);
  record = reduceTarget(record, { type: "batch-too-large", now: NOW }, CONFIG);
  assert.equal(record.batchTooLargeCount, 2);
  assert.equal(record.batchSizeNotches, 0);
  assert.equal(record.phase, PHASE.BATCH_READY);

  record = reduceTarget(record, { type: "batch-too-large", now: NOW }, CONFIG);
  assert.equal(record.batchTooLargeCount, 3);
  assert.equal(record.batchSizeNotches, 1);
  assert.equal(record.phase, PHASE.NEEDS_OBSERVATION);

  record = reduceTarget(
    { ...record, phase: PHASE.BATCH_READY },
    {
      type: "group-committed",
      groupId: "g",
      purpose: "batch",
      now: NOW,
    },
    CONFIG,
  );
  assert.equal(record.batchTooLargeCount, 0);
  assert.equal(record.batchSizeNotches, 0);
});

test("a finished group settles and returns to NEEDS_OBSERVATION, never straight to ready", () => {
  let record = batchReady("n00dles", 100);
  record = reduceTarget(
    record,
    { type: "group-committed", groupId: "g1", purpose: "batch", now: NOW },
    CONFIG,
  );
  assert.equal(record.phase, PHASE.BATCH_IN_FLIGHT);
  assert.equal(record.activeGroupId, "g1");

  record = reduceTarget(
    record,
    { type: "receipts-terminal", now: NOW },
    CONFIG,
  );
  assert.equal(record.phase, PHASE.SETTLING);

  const tooSoon = reduceTarget(
    record,
    { type: "settled", now: record.settleAfter - 1 },
    CONFIG,
  );
  assert.equal(
    tooSoon.phase,
    PHASE.SETTLING,
    "settlement buffer must elapse first",
  );

  record = reduceTarget(
    record,
    { type: "settled", now: record.settleAfter },
    CONFIG,
  );
  assert.equal(record.phase, PHASE.NEEDS_OBSERVATION);
  assert.equal(record.activeGroupId, null);
});

test("a launch failure applies backoff and requires re-observation", () => {
  let record = batchReady("n00dles", 100);
  record = reduceTarget(
    record,
    { type: "launch-failed", reason: "exec returned 0", now: NOW },
    CONFIG,
  );

  assert.equal(record.phase, PHASE.BACKOFF);
  assert.equal(record.dirtyReason, "exec returned 0");
  assert.equal(
    reduceTarget(
      record,
      { type: "backoff-elapsed", now: record.backoffUntil - 1 },
      CONFIG,
    ).phase,
    PHASE.BACKOFF,
  );
  assert.equal(
    reduceTarget(
      record,
      { type: "backoff-elapsed", now: record.backoffUntil },
      CONFIG,
    ).phase,
    PHASE.NEEDS_OBSERVATION,
  );
});

test("targets transition independently", () => {
  const a = batchReady("alpha", 100);
  const b = batchReady("beta", 200);

  const movedA = reduceTarget(
    a,
    { type: "group-committed", groupId: "g1", purpose: "batch", now: NOW },
    CONFIG,
  );

  assert.equal(movedA.phase, PHASE.BATCH_IN_FLIGHT);
  assert.equal(b.phase, PHASE.BATCH_READY, "target B must be untouched");
});

// -----------------------------------------------------------------------------
// Multiple target prioritization
// -----------------------------------------------------------------------------

test("the highest expected dollars-per-second target is scheduled first", () => {
  const decision = run(
    [
      batchReady("poor", 100),
      batchReady("rich", 5000),
      batchReady("middling", 800),
    ],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.equal(decision.target, "rich");
});

test("only one group is committed per decision", () => {
  const decision = run(
    [batchReady("rich", 5000), batchReady("poor", 100)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.equal(new Set(decision.allocations.map((f) => f.target)).size, 1);
});

test("an in-flight batch chain can append a complete continuation at its window", () => {
  const initial = planBatchGroup({
    target: "n00dles",
    batch: SMALL_BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "mm-chain-n00dles",
    targetGeneration: 1,
    plannedAt: NOW,
  });
  const allocation = allocateJobs(
    createLedger(snapshots([{ host: "runner", maxRam: 1024, usedRam: 0 }])),
    initial.jobs,
  );
  const inFlight = publishGroup(
    createInFlightLedger(),
    initial,
    allocation.allocations,
    allocation.allocations.map((_, index) => index + 1),
    NOW,
  );
  const active = reduceTarget(
    batchReady("n00dles", 100),
    {
      type: "group-committed",
      groupId: initial.id,
      purpose: "batch",
      batchCount: initial.batchCount,
      now: NOW,
    },
    CONFIG,
  );
  assert.equal(active.scheduledBatchCount, 1);
  const window = continuationWindow(active, inFlight, CONFIG);
  assert.ok(window);

  const decision = decide({
    targets: [active],
    snapshots: snapshots([{ host: "runner", maxRam: 1024, usedRam: 0 }]),
    inFlight,
    workers: WORKERS,
    config: CONFIG,
    now: window.launchAt,
    serial: 2,
  });

  assert.equal(decision.kind, "batch");
  assert.equal(decision.group.id, initial.id);
  assert.equal(decision.group.continuation, true);
  assert.equal(decision.group.jobs[0].batchId, `${initial.id}-1`);

  const firstHack = decision.group.jobs.find((job) => job.label === "H");
  assert.ok(
    decision.group.plannedAt + firstHack.delay + firstHack.duration >=
      window.lastEndAt + CONFIG.landingGap,
  );
});

test("a recorded terminal fault prevents batch-chain continuation", () => {
  const initial = planBatchGroup({
    target: "n00dles",
    batch: SMALL_BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "mm-faulted-chain",
    targetGeneration: 1,
    plannedAt: NOW,
  });
  const allocation = allocateJobs(
    createLedger(snapshots([{ host: "runner", maxRam: 1024, usedRam: 0 }])),
    initial.jobs,
  );
  let inFlight = publishGroup(
    createInFlightLedger(),
    initial,
    allocation.allocations,
    allocation.allocations.map((_, index) => index + 1),
    NOW,
  );
  inFlight = {
    ...inFlight,
    groupFaults: {
      [initial.id]: {
        lost: 1,
        late: 0,
        killed: 0,
        firstFaultAt: NOW,
      },
    },
  };
  const active = reduceTarget(
    batchReady("n00dles", 100),
    {
      type: "group-committed",
      groupId: initial.id,
      purpose: "batch",
      batchCount: 1,
      now: NOW,
    },
    CONFIG,
  );

  assert.equal(continuationWindow(active, inFlight, CONFIG), null);
});

test("a failed continuation keeps the existing chain locked and marks it dirty", () => {
  const active = reduceTarget(
    batchReady("n00dles", 100),
    {
      type: "group-committed",
      groupId: "chain",
      purpose: "batch",
      batchCount: 2,
      now: NOW,
    },
    CONFIG,
  );
  const failed = reduceTarget(
    active,
    {
      type: "continuation-failed",
      reason: "commit validation moved",
      now: NOW + 1,
    },
    CONFIG,
  );

  assert.equal(failed.phase, PHASE.BATCH_IN_FLIGHT);
  assert.equal(failed.activeGroupId, "chain");
  assert.equal(failed.dirtyReason, "commit validation moved");
});

test("a lower-ranked complete batch is chosen when the top target cannot fit", () => {
  const decision = run(
    [
      batchReady("rich", 5000, HUGE_BATCH),
      batchReady("poor", 100, SMALL_BATCH),
    ],
    [{ host: "alpha", maxRam: 60, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.equal(decision.target, "poor");
  assert.ok(
    decision.reasons.some(
      (r) =>
        r.host === "rich" && r.code === IDLE_REASON.COMPLETE_BATCH_TOO_LARGE,
    ),
    "the rejected top target must still be explained",
  );
});

test("hostname breaks ranking ties deterministically", () => {
  const decision = run(
    [batchReady("zulu", 1000), batchReady("alpha", 1000)],
    [{ host: "runner", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.target, "alpha");
});

test("a BATCH_READY target with no profitable batch is reported, not scheduled", () => {
  const flat = {
    ...batchReady("n00dles", 0),
    economics: { preparedBatch: SMALL_BATCH, expectedMoneyPerSecond: 0 },
  };
  const decision = run([flat], [{ host: "alpha", maxRam: 512, usedRam: 0 }]);

  assert.equal(decision.kind, "idle");
  assert.equal(decision.dominantReason, IDLE_REASON.NO_PROFITABLE_BATCH);
});

// -----------------------------------------------------------------------------
// Preparation versus income work
// -----------------------------------------------------------------------------

test("a complete batch outranks preparation even when prep is far cheaper", () => {
  const decision = run(
    [moneyPrepReady("prepme", 9999), batchReady("earner", 10)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.equal(decision.target, "earner");
});

test("prep runs on RAM the batch pass left idle", () => {
  const busyEarner = {
    ...batchReady("earner", 10),
    activeGroupId: "g1",
    phase: PHASE.BATCH_IN_FLIGHT,
  };
  const decision = run(
    [busyEarner, moneyPrepReady("prepme", 50)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "prep");
  assert.equal(decision.target, "prepme");
  assert.equal(decision.group.purpose, "money-prep");
});

test("security prep is a single complete weaken group", () => {
  const decision = run(
    [securityPrepReady("dirty", 50)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "prep");
  assert.equal(decision.group.purpose, "security-prep");
  assert.equal(decision.group.jobs.length, 1);
  assert.equal(decision.group.jobs[0].threads, 8);
});

test("a target needing security and money receives combined grow plus weaken prep", () => {
  const target = securityPrepReady("alpha", 100);
  target.observation = observation({ security: 20, money: 1_000 });
  target.economics = {
    ...target.economics,
    moneyPrep: MONEY_PREP,
  };

  const decision = run(
    [target],
    [{ host: "runner", maxRam: 1024, usedRam: 0 }],
  );

  assert.equal(decision.kind, "prep");
  assert.equal(decision.group.purpose, "security-prep");
  assert.deepEqual(decision.group.jobs.map((job) => job.operation).sort(), [
    "grow",
    "weaken",
  ]);
  assert.equal(
    decision.group.jobs.find((job) => job.operation === "weaken").threads,
    9,
    "8 existing-security threads plus 1 grow compensator",
  );
});

test("money prep shrinks to fit rather than failing outright", () => {
  const hungry = moneyPrepReady("huge", 50);
  hungry.economics.moneyPrep = { ...MONEY_PREP, growThreadsNeeded: 100_000 };

  // 20 GB = 2000 units: room for 10 grow (1750) plus 1 weaken (175).
  const decision = run([hungry], [{ host: "alpha", maxRam: 20, usedRam: 0 }]);

  assert.equal(decision.kind, "prep");

  const grow = decision.group.jobs.find((job) => job.operation === "grow");
  const weaken = decision.group.jobs.find((job) => job.operation === "weaken");

  assert.equal(grow.threads, 10);
  assert.equal(weaken.threads, 1, "the compensating weaken is never dropped");
  assert.ok(requiredUnits(decision.group.jobs) <= 2000);
});

test("security prep shrinks to fit and never drops below one thread", () => {
  const dirty = securityPrepReady("dirty", 50);
  dirty.economics.securityPrep = { threadsNeeded: 5000, weakenTime: 4000 };

  const decision = run([dirty], [{ host: "alpha", maxRam: 10, usedRam: 0 }]);

  assert.equal(decision.kind, "prep");
  assert.equal(decision.group.jobs.length, 1);
  assert.equal(
    decision.group.jobs[0].threads,
    5,
    "1000 units / 175 = 5 threads",
  );
});

test("prep still fails cleanly when even one grow pair cannot fit", () => {
  const decision = run(
    [moneyPrepReady("tiny", 50)],
    [{ host: "alpha", maxRam: 2, usedRam: 0 }],
  );

  assert.equal(decision.kind, "idle");
  assert.equal(decision.dominantReason, IDLE_REASON.PREP_GROUP_TOO_LARGE);
});

test("aging promotes a long-waiting prep target over a richer newcomer", () => {
  const stale = moneyPrepReady("patient", 10, NOW - CONFIG.prepAgingMs - 1);
  const fresh = moneyPrepReady("wealthy", 5000, NOW);

  const decision = run(
    [stale, fresh],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "prep");
  assert.equal(decision.target, "patient");
});

test("prep ordering uses fallback priority when batch economics are unavailable", () => {
  const maxSecurity = securityPrepReady("max-security", 0);
  maxSecurity.economics = {
    ...maxSecurity.economics,
    prepPriority: 500,
  };
  const ordinary = securityPrepReady("ordinary", 100);

  const decision = run(
    [ordinary, maxSecurity],
    [{ host: "runner", maxRam: 1024, usedRam: 0 }],
  );

  assert.equal(decision.kind, "prep");
  assert.equal(decision.target, "max-security");
});

test("prep is refused when it would delay a batch window that is already known", () => {
  // The batch needs more RAM than is free; in-flight work will release enough
  // at a known time, and this prep would still be holding RAM then.
  const inFlight = (() => {
    const ledger = createLedger(
      snapshots([{ host: "reserved", maxRam: 200, usedRam: 0 }]),
    );
    const group = planBatchGroup({
      target: "other",
      batch: SMALL_BATCH,
      workers: WORKERS,
      config: CONFIG,
      batchCount: 4,
      groupId: "inflight",
      plannedAt: NOW,
    });
    const allocation = allocateJobs(ledger, group.jobs);
    return publishGroup(
      createInFlightLedger(),
      group,
      allocation.allocations,
      allocation.allocations.map((_, i) => 200 + i),
      NOW,
    );
  })();

  // 6000 units free, the batch needs 6800, and the first in-flight release
  // (850 units at NOW+5000) covers that 800-unit shortfall. The prep group
  // holds 1925 units until NOW+5200, past that window.
  const decision = decide({
    targets: [
      batchReady("earner", 5000, MEDIUM_BATCH),
      moneyPrepReady("prepme", 50),
    ],
    snapshots: snapshots([{ host: "alpha", maxRam: 60, usedRam: 0 }]),
    inFlight,
    workers: WORKERS,
    config: CONFIG,
    now: NOW,
    serial: 1,
  });

  assert.equal(decision.kind, "idle");
  assert.ok(
    decision.reasons.some(
      (r) => r.code === IDLE_REASON.RESERVED_FOR_BATCH_WINDOW,
    ),
    `expected RESERVED_FOR_BATCH_WINDOW, got ${JSON.stringify(decision.reasons)}`,
  );
});

test("the batch-window guard allows prep that returns its RAM in time", () => {
  const inFlight = {
    receipts: [
      {
        receiptId: "r1",
        groupId: "g",
        logicalJobId: "j",
        target: "other",
        operation: "weaken",
        runner: "x",
        threads: 1,
        units: 4000,
        pid: 1,
        plannedAt: NOW,
        expectedStartAt: NOW,
        expectedEndAt: NOW + 10_000,
        status: RECEIPT_STATUS.LAUNCHED,
      },
    ],
    groupFaults: {},
  };

  const early = batchWindowGuard({
    prepGroup: { expectedLastEndAt: NOW + 5_000 },
    prepUnits: 2100,
    pendingBatch: { host: "earner", requiredUnits: 8000 },
    inFlight,
    freeUnits: 5000,
  });
  assert.equal(
    early.allowed,
    true,
    "prep that finishes before the window is harmless",
  );

  const late = batchWindowGuard({
    prepGroup: { expectedLastEndAt: NOW + 41_200 },
    prepUnits: 2100,
    pendingBatch: { host: "earner", requiredUnits: 8000 },
    inFlight,
    freeUnits: 5000,
  });
  assert.equal(
    late.allowed,
    false,
    "prep that starves the window must be refused",
  );

  const tiny = batchWindowGuard({
    prepGroup: { expectedLastEndAt: NOW + 41_200 },
    prepUnits: 100,
    pendingBatch: { host: "earner", requiredUnits: 8000 },
    inFlight,
    freeUnits: 5000,
  });
  assert.equal(
    tiny.allowed,
    true,
    "prep small enough to leave the window intact is fine",
  );
});

test("with no pending batch there is no window to protect", () => {
  const guard = batchWindowGuard({
    prepGroup: { expectedLastEndAt: NOW + 99_999 },
    prepUnits: 5000,
    pendingBatch: null,
    inFlight: createInFlightLedger(),
    freeUnits: 1000,
  });

  assert.equal(guard.allowed, true);
});

// -----------------------------------------------------------------------------
// Target concurrency limits
// -----------------------------------------------------------------------------

test("a target with a committed group produces no candidate", () => {
  const busy = { ...batchReady("n00dles", 1000), activeGroupId: "g1" };
  const eligibility = checkEligibility(
    busy,
    createInFlightLedger(),
    CONFIG,
    NOW,
  );

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, IDLE_REASON.ALL_TARGETS_BUSY);
});

test("a target with live receipts produces no candidate even if its phase looks ready", () => {
  const ledger = createLedger(
    snapshots([{ host: "alpha", maxRam: 200, usedRam: 0 }]),
  );
  const group = planBatchGroup({
    target: "n00dles",
    batch: SMALL_BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "g1",
    plannedAt: NOW,
  });
  const allocation = allocateJobs(ledger, group.jobs);
  const inFlight = publishGroup(
    createInFlightLedger(),
    group,
    allocation.allocations,
    allocation.allocations.map((_, i) => 300 + i),
    NOW,
  );

  const eligibility = checkEligibility(
    batchReady("n00dles", 1000),
    inFlight,
    CONFIG,
    NOW,
  );

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, IDLE_REASON.ALL_TARGETS_BUSY);
});

test("in-flight and settling phases are never re-scheduled", () => {
  for (const phase of [
    PHASE.BATCH_IN_FLIGHT,
    PHASE.PREP_IN_FLIGHT,
    PHASE.SETTLING,
  ]) {
    const record = { ...batchReady("n00dles", 1000), phase };
    const eligibility = checkEligibility(
      record,
      createInFlightLedger(),
      CONFIG,
      NOW,
    );
    assert.equal(
      eligibility.eligible,
      false,
      `${phase} must not be schedulable`,
    );
  }
});

test("a stale observation is rejected rather than used", () => {
  const stale = {
    ...batchReady("n00dles", 1000),
    observation: observation({ observedAt: NOW - CONFIG.observationTtlMs - 1 }),
  };

  const eligibility = checkEligibility(
    stale,
    createInFlightLedger(),
    CONFIG,
    NOW,
  );

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, IDLE_REASON.STALE_SNAPSHOT);
});

test("a target inside its backoff window is not scheduled", () => {
  const record = {
    ...batchReady("n00dles", 1000),
    phase: PHASE.BACKOFF,
    backoffUntil: NOW + 1000,
  };
  const eligibility = checkEligibility(
    record,
    createInFlightLedger(),
    CONFIG,
    NOW,
  );

  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, IDLE_REASON.LAUNCH_BACKOFF);
});

test("a busy target does not block a different ready target", () => {
  const busy = {
    ...batchReady("busy", 9999),
    activeGroupId: "g1",
    phase: PHASE.BATCH_IN_FLIGHT,
  };
  const decision = run(
    [busy, batchReady("free", 10)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.equal(decision.target, "free");
});

test("when every target is busy the decision is idle with a reason", () => {
  const busy = {
    ...batchReady("busy", 9999),
    activeGroupId: "g1",
    phase: PHASE.BATCH_IN_FLIGHT,
  };
  const decision = run([busy], [{ host: "alpha", maxRam: 512, usedRam: 0 }]);

  assert.equal(decision.kind, "idle");
  assert.equal(decision.dominantReason, IDLE_REASON.ALL_TARGETS_BUSY);
  assert.ok(decision.idleUnits > 0, "idle RAM must be quantified");
});

// -----------------------------------------------------------------------------
// Idle explanation
// -----------------------------------------------------------------------------

test("every idle decision carries at least one structured reason", () => {
  const decisions = [
    run([], [{ host: "alpha", maxRam: 512, usedRam: 0 }]),
    run(
      [createTargetRecord("unobserved")],
      [{ host: "alpha", maxRam: 512, usedRam: 0 }],
    ),
    run(
      [batchReady("big", 100, HUGE_BATCH)],
      [{ host: "alpha", maxRam: 16, usedRam: 0 }],
    ),
  ];

  for (const decision of decisions) {
    assert.equal(decision.kind, "idle");
    assert.ok(decision.dominantReason, "a dominant reason is required");
  }
});

test("a conflicting manager blocks all scheduling", () => {
  const decision = run(
    [batchReady("rich", 5000)],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
    { conflictingManager: true },
  );

  assert.equal(decision.kind, "idle");
  assert.equal(decision.dominantReason, IDLE_REASON.CONFLICTING_MANAGER);
});

test("an unobserved target reports WAITING_FOR_OBSERVATION", () => {
  const decision = run(
    [createTargetRecord("fresh")],
    [{ host: "alpha", maxRam: 512, usedRam: 0 }],
  );

  assert.equal(decision.dominantReason, IDLE_REASON.WAITING_FOR_OBSERVATION);
});

test("idle reasons name the target they belong to", () => {
  const decision = run(
    [batchReady("big", 100, HUGE_BATCH)],
    [{ host: "alpha", maxRam: 16, usedRam: 0 }],
  );

  assert.deepEqual(
    decision.reasons.map((r) => r.host),
    ["big"],
  );
  assert.equal(decision.reasons[0].code, IDLE_REASON.COMPLETE_BATCH_TOO_LARGE);
});

test("the requested wave is capped by config.maxBatches", () => {
  const ledger = createLedger(
    snapshots([{ host: "alpha", maxRam: 4096, usedRam: 0 }]),
  );
  const decision = run(
    [batchReady("rich", 5000)],
    [{ host: "alpha", maxRam: 4096, usedRam: 0 }],
  );

  assert.equal(decision.kind, "batch");
  assert.ok(decision.group.batchCount <= CONFIG.maxBatches);
  assert.ok(requiredUnits(decision.group.jobs) <= 4096 * 100);
  assert.ok(ledger.entries.length > 0);
});
