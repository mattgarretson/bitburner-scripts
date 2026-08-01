import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  IDLE_REASON,
  REJECTION,
  RECEIPT_STATUS,
  allocateJobs,
  applyReceiptStatus,
  classifyReceipt,
  createInFlightLedger,
  createLedger,
  earliestReleaseTime,
  planBatchGroup,
  planLargestWave,
  planMoneyPrepGroup,
  planSecurityPrepGroup,
  publishGroup,
  ramInFlightUnits,
  releaseCalendar,
  requiredUnits,
  snapshotRunners,
  targetHasLiveReceipts,
  totalUnits,
  validateGroup,
} from "../src/multi-planning.ts";

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

/** A batch costing 5*170 + 20*175 + 3*175 = 4875 units (48.75 GB). */
const BATCH = {
  hackThreads: 5,
  growThreads: 20,
  weakenHackThreads: 1,
  weakenGrowThreads: 2,
  hackTime: 1000,
  growTime: 2000,
  weakenTime: 4000,
  expectedMoney: 1_000_000,
};

function ledgerOf(runners) {
  return createLedger(snapshotRunners(runners, CONFIG));
}

function weakenJobs(threads) {
  return planSecurityPrepGroup({
    target: "n00dles",
    threads,
    weakenTime: 4000,
    workers: WORKERS,
    config: CONFIG,
    groupId: "g1",
  }).jobs;
}

// -----------------------------------------------------------------------------
// RAM allocation across differently sized hosts
// -----------------------------------------------------------------------------

test("home reserve is removed from the snapshot before planning sees it", () => {
  const [alpha, home] = snapshotRunners(
    [
      { host: "alpha", maxRam: 32, usedRam: 0 },
      { host: "home", maxRam: 64, usedRam: 0 },
    ],
    CONFIG,
  );

  assert.equal(alpha.homeReserve, 0);
  assert.equal(alpha.allocatableRam, 32);
  assert.equal(home.homeReserve, 8);
  assert.equal(home.allocatableRam, 56);
});

test("home reserve still applies when home is already heavily used", () => {
  const [home] = snapshotRunners(
    [{ host: "home", maxRam: 64, usedRam: 60 }],
    CONFIG,
  );
  assert.equal(home.allocatableRam, 0);
  assert.equal(home.allocatableUnits, 0);
});

test("a split job spreads across differently sized hosts and preserves the thread count", () => {
  const ledger = ledgerOf([
    { host: "alpha", maxRam: 32, usedRam: 0 },
    { host: "beta", maxRam: 16, usedRam: 0 },
    { host: "home", maxRam: 64, usedRam: 0 },
  ]);

  const result = allocateJobs(ledger, weakenJobs(30));
  assert.equal(result.ok, true);

  const total = result.allocations.reduce((sum, f) => sum + f.threads, 0);
  assert.equal(total, 30, "every requested thread must be placed");

  const byHost = Object.fromEntries(
    result.allocations.map((f) => [f.host, f.threads]),
  );
  assert.deepEqual(byHost, { alpha: 18, beta: 9, home: 3 });

  // No runner may be oversubscribed, and home is drained last.
  for (const entry of result.ledger.entries) {
    assert.ok(entry.units >= 0, `${entry.host} went negative`);
  }
});

test("allocation is deterministic for identical input", () => {
  const runners = [
    { host: "beta", maxRam: 16, usedRam: 0 },
    { host: "alpha", maxRam: 32, usedRam: 0 },
    { host: "home", maxRam: 64, usedRam: 0 },
  ];

  const first = allocateJobs(ledgerOf(runners), weakenJobs(25));
  const second = allocateJobs(ledgerOf(runners), weakenJobs(25));

  assert.deepEqual(first.allocations, second.allocations);
});

test("a successful allocation does not mutate the input ledger", () => {
  const ledger = ledgerOf([{ host: "alpha", maxRam: 64, usedRam: 0 }]);
  const before = totalUnits(ledger);

  const result = allocateJobs(ledger, weakenJobs(10));

  assert.equal(result.ok, true);
  assert.equal(totalUnits(ledger), before, "input ledger must be untouched");
  assert.equal(totalUnits(result.ledger), before - 10 * 175);
});

// -----------------------------------------------------------------------------
// Insufficient RAM
// -----------------------------------------------------------------------------

test("a total shortage rejects with INSUFFICIENT_TOTAL_RAM and leaves the ledger unchanged", () => {
  const ledger = ledgerOf([{ host: "alpha", maxRam: 8, usedRam: 0 }]);
  const before = totalUnits(ledger);

  const result = allocateJobs(ledger, weakenJobs(30));

  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, REJECTION.INSUFFICIENT_TOTAL_RAM);
  assert.equal(result.rejection.requiredUnits, 30 * 175);
  assert.equal(result.rejection.availableUnits, 800);
  assert.equal(result.rejection.shortfallUnits, 30 * 175 - 800);
  assert.equal(totalUnits(ledger), before);
  assert.equal(
    result.allocations,
    undefined,
    "nothing may be handed back on failure",
  );
});

test("aggregate RAM that cannot host one thread reports BELOW_SMALLEST_THREAD", () => {
  const ledger = ledgerOf([
    { host: "a", maxRam: 1, usedRam: 0 },
    { host: "b", maxRam: 1, usedRam: 0 },
    { host: "c", maxRam: 1, usedRam: 0 },
    { host: "d", maxRam: 1, usedRam: 0 },
    { host: "e", maxRam: 1, usedRam: 0 },
  ]);

  const result = allocateJobs(ledger, weakenJobs(2));

  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, REJECTION.BELOW_SMALLEST_THREAD);
  assert.ok(result.rejection.availableUnits >= result.rejection.requiredUnits);
  assert.ok(
    result.rejection.largestHostUnits < result.rejection.smallestThreadUnits,
  );
});

test("a runner missing workers is excluded and blamed", () => {
  const ledger = ledgerOf([
    { host: "alpha", maxRam: 64, usedRam: 0, workersAvailable: false },
  ]);

  const result = allocateJobs(ledger, weakenJobs(2));

  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, REJECTION.WORKERS_NOT_DEPLOYED);
  assert.equal(result.rejection.availableUnits, 0);
  assert.equal(result.rejection.blockedUnits, 6400);
});

// -----------------------------------------------------------------------------
// No partial batch allocation
// -----------------------------------------------------------------------------

test("a wave shrinks by whole batches only", () => {
  // 100 GB = 10000 units; one batch costs 4875, so exactly two fit.
  const ledger = ledgerOf([{ host: "alpha", maxRam: 100, usedRam: 0 }]);

  const result = planLargestWave({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    ledger,
    groupId: "w1",
    maxBatches: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.batchCount, 2);
  assert.equal(
    result.group.jobs.length,
    8,
    "two batches means eight logical jobs",
  );
  assert.equal(requiredUnits(result.group.jobs), 9750);
  assert.deepEqual(validateGroup(result.group), { ok: true, problems: [] });
});

test("every batch in a wave keeps all four operations", () => {
  const ledger = ledgerOf([{ host: "alpha", maxRam: 512, usedRam: 0 }]);

  const result = planLargestWave({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    ledger,
    groupId: "w1",
    maxBatches: 6,
  });

  assert.equal(result.ok, true);
  assert.equal(result.batchCount, 6);

  const byBatch = new Map();
  for (const job of result.group.jobs) {
    byBatch.set(job.batchId, [...(byBatch.get(job.batchId) ?? []), job.label]);
  }

  assert.equal(byBatch.size, 6);
  for (const labels of byBatch.values()) {
    assert.deepEqual([...labels].sort(), ["G", "H", "W1", "W2"]);
  }
});

test("a wave that cannot fit even one complete batch allocates nothing", () => {
  // 40 GB = 4000 units, below the 4875 a single batch needs.
  const ledger = ledgerOf([{ host: "alpha", maxRam: 40, usedRam: 0 }]);

  const result = planLargestWave({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    ledger,
    groupId: "w1",
    maxBatches: 20,
  });

  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, IDLE_REASON.COMPLETE_BATCH_TOO_LARGE);
  assert.equal(result.rejection.requiredUnits, 4875);
  assert.equal(result.group, undefined);
  assert.equal(result.allocations, undefined);
});

test("validateGroup catches a batch missing an operation", () => {
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "w1",
  });

  const mutilated = {
    ...group,
    jobs: group.jobs.filter((job) => job.label !== "W2"),
  };
  const verdict = validateGroup(mutilated);

  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => p.includes("missing W2")));
});

test("money prep never contains grow without its weaken", () => {
  const group = planMoneyPrepGroup({
    target: "n00dles",
    prep: {
      growThreads: 12,
      weakenThreads: 3,
      growTime: 2000,
      weakenTime: 4000,
    },
    workers: WORKERS,
    config: CONFIG,
    groupId: "p1",
  });

  assert.deepEqual(group.jobs.map((job) => job.operation).sort(), [
    "grow",
    "weaken",
  ]);
  assert.equal(validateGroup(group).ok, true);
  assert.equal(validateGroup({ ...group, jobs: [group.jobs[0]] }).ok, false);
});

// -----------------------------------------------------------------------------
// Timing
// -----------------------------------------------------------------------------

test("planned landing order is H, W1, G, W2 separated by the configured gap", () => {
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "w1",
  });

  const landings = group.jobs.map((job) => ({
    label: job.label,
    at: job.delay + job.duration,
  }));

  assert.deepEqual(landings, [
    { label: "H", at: 5000 },
    { label: "W1", at: 5200 },
    { label: "G", at: 5400 },
    { label: "W2", at: 5600 },
  ]);

  assert.equal(group.expectedLastEndAt, 5600);
});

test("batches within a wave are spaced by four gaps", () => {
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 2,
    groupId: "w1",
  });

  const first = group.jobs.find(
    (job) => job.batchId === "w1-0" && job.label === "H",
  );
  const second = group.jobs.find(
    (job) => job.batchId === "w1-1" && job.label === "H",
  );

  assert.equal(second.delay - first.delay, 4 * CONFIG.landingGap);
});

test("expectedLastEndAt is absolute when plannedAt is supplied", () => {
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "w1",
    plannedAt: 10_000,
  });

  assert.equal(group.expectedLastEndAt, 15_600);
});

// -----------------------------------------------------------------------------
// In-flight job accounting
// -----------------------------------------------------------------------------

function launchedGroup(now = 1000) {
  const ledger = ledgerOf([{ host: "alpha", maxRam: 100, usedRam: 0 }]);
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "w1",
    plannedAt: now,
  });
  const allocation = allocateJobs(ledger, group.jobs);
  const pids = allocation.allocations.map((_, index) => 100 + index);
  return {
    group,
    allocation,
    inFlight: publishGroup(
      createInFlightLedger(),
      group,
      allocation.allocations,
      pids,
      now,
    ),
  };
}

test("publishing a group records one receipt per fragment with its runner and pid", () => {
  const { allocation, inFlight } = launchedGroup();

  assert.equal(inFlight.receipts.length, allocation.allocations.length);

  for (const [index, receipt] of inFlight.receipts.entries()) {
    const fragment = allocation.allocations[index];
    assert.equal(receipt.runner, fragment.host);
    assert.equal(receipt.threads, fragment.threads);
    assert.equal(receipt.pid, 100 + index);
    assert.equal(receipt.logicalJobId, fragment.logicalJobId);
    assert.equal(receipt.status, RECEIPT_STATUS.LAUNCHED);
  }
});

test("in-flight RAM equals what was allocated, and drops as receipts go terminal", () => {
  const { allocation, inFlight } = launchedGroup();

  assert.equal(ramInFlightUnits(inFlight), allocation.unitsAllocated);

  const first = inFlight.receipts[0];
  const after = applyReceiptStatus(
    inFlight,
    first.receiptId,
    RECEIPT_STATUS.FINISHED_UNVERIFIED,
  );

  assert.equal(
    ramInFlightUnits(after),
    allocation.unitsAllocated - first.units,
  );
});

test("a target is locked while any of its receipts is live", () => {
  const { inFlight } = launchedGroup();

  assert.equal(targetHasLiveReceipts(inFlight, "n00dles"), true);
  assert.equal(targetHasLiveReceipts(inFlight, "joesguns"), false);

  let settled = inFlight;
  for (const receipt of inFlight.receipts) {
    settled = applyReceiptStatus(
      settled,
      receipt.receiptId,
      RECEIPT_STATUS.FINISHED_UNVERIFIED,
    );
  }

  assert.equal(targetHasLiveReceipts(settled, "n00dles"), false);
});

test("receipt classification distinguishes running, late, finished and lost", () => {
  const { inFlight } = launchedGroup(1000);
  const receipt = inFlight.receipts[0];
  const end = receipt.expectedEndAt;

  assert.equal(
    classifyReceipt(receipt, {
      isRunning: true,
      now: end - 1000,
      config: CONFIG,
    }),
    RECEIPT_STATUS.LAUNCHED,
  );
  assert.equal(
    classifyReceipt(receipt, {
      isRunning: true,
      now: end + CONFIG.lateToleranceMs + 1,
      config: CONFIG,
    }),
    RECEIPT_STATUS.LATE,
  );
  assert.equal(
    classifyReceipt(receipt, { isRunning: false, now: end, config: CONFIG }),
    RECEIPT_STATUS.FINISHED_UNVERIFIED,
  );
  assert.equal(
    classifyReceipt(receipt, {
      isRunning: false,
      now: end - CONFIG.earlyToleranceMs - 1,
      config: CONFIG,
    }),
    RECEIPT_STATUS.LOST,
  );
});

test("a late receipt still counts as live RAM", () => {
  const { allocation, inFlight } = launchedGroup();
  const late = applyReceiptStatus(
    inFlight,
    inFlight.receipts[0].receiptId,
    RECEIPT_STATUS.LATE,
  );

  assert.equal(ramInFlightUnits(late), allocation.unitsAllocated);
  assert.equal(targetHasLiveReceipts(late, "n00dles"), true);
});

test("the release calendar is ordered and answers when RAM comes back", () => {
  const { inFlight } = launchedGroup(1000);
  const calendar = releaseCalendar(inFlight);

  for (let i = 1; i < calendar.length; i++) {
    assert.ok(calendar[i].at >= calendar[i - 1].at, "calendar must ascend");
  }

  const total = calendar.reduce((sum, event) => sum + event.units, 0);
  assert.equal(
    earliestReleaseTime(inFlight, total),
    calendar[calendar.length - 1].at,
  );
  assert.equal(
    earliestReleaseTime(inFlight, calendar[0].units),
    calendar[0].at,
  );
  assert.equal(
    earliestReleaseTime(inFlight, total + 1),
    null,
    "unreachable shortfall has no window",
  );
});
