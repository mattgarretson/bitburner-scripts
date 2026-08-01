import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  RECEIPT_STATUS,
  allocateJobs,
  createInFlightLedger,
  createLedger,
  planBatchGroup,
  publishGroup,
  snapshotRunners,
} from "../src/multi-planning.ts";

import {
  commitGroup,
  detectConflictingManager,
  pollReceipts,
  readRunners,
  recoverTaggedProcesses,
} from "../src/multi-runtime.ts";

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
  launchSafetyMs: 250,
};

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

/** Minimal Netscript stand-in: only what the adapter actually calls. */
function fakeNs(overrides = {}) {
  return {
    pid: 1,
    getScriptName: () => "multi-manager.ts",
    ps: () => [],
    hasRootAccess: () => true,
    getServerMaxRam: () => 1024,
    getServerUsedRam: () => 0,
    fileExists: () => true,
    getServer: () => ({
      hasAdminRights: true,
      purchasedByPlayer: false,
      moneyAvailable: 1_000_000,
      moneyMax: 1_000_000,
      hackDifficulty: 1,
      minDifficulty: 1,
    }),
    isRunning: () => true,
    exec: () => 1,
    kill: () => true,
    ...overrides,
  };
}

function plannedGroup(plannedAt = Date.now()) {
  const ledger = createLedger(
    snapshotRunners([{ host: "alpha", maxRam: 1024, usedRam: 0 }], CONFIG),
  );
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "mm-b1-n00dles",
    plannedAt,
  });
  const allocation = allocateJobs(ledger, group.jobs);
  return { group, allocations: allocation.allocations };
}

// -----------------------------------------------------------------------------
// commitGroup
// -----------------------------------------------------------------------------

test("a successful commit execs every fragment in delay order", () => {
  const { group, allocations } = plannedGroup();
  /** @type {number[]} */
  const delays = [];
  let nextPid = 100;

  const ns = fakeNs({
    exec: (script, host, opts, ...args) => {
      delays.push(Number(args[1]));
      return nextPid++;
    },
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, true);
  assert.equal(result.pids.length, allocations.length);
  assert.deepEqual(
    delays,
    [...delays].sort((a, b) => a - b),
    "delay order",
  );
});

test("plannedAt is stamped into argument 2 so workers can subtract launch skew", () => {
  const { group, allocations } = plannedGroup();
  /** @type {number[]} */
  const stamped = [];

  const ns = fakeNs({
    exec: (script, host, opts, ...args) => {
      stamped.push(Number(args[2]));
      return 1;
    },
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, true);
  for (const value of stamped) assert.equal(value, result.plannedAt);
});

test("a failed exec partway through kills every PID already launched", () => {
  const { group, allocations } = plannedGroup();
  /** @type {number[]} */
  const killed = [];
  let calls = 0;

  const ns = fakeNs({
    exec: () => {
      calls++;
      return calls === 3 ? 0 : calls;
    },
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    isRunning: () => false,
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /exec failed/);
  assert.deepEqual(
    killed,
    [1, 2],
    "both earlier fragments must be rolled back",
  );
  assert.equal(result.rolledBack, 2, "rollback is verified, not assumed");
});

test("a commit is refused when runner free RAM changed during planning", () => {
  const { group, allocations } = plannedGroup();
  let execCalls = 0;

  const ns = fakeNs({
    getServerUsedRam: () => 1020,
    exec: () => {
      execCalls++;
      return 1;
    },
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /free RAM changed/);
  assert.equal(execCalls, 0, "nothing may launch after a failed revalidation");
});

test("a commit is refused when planning consumed the launch lead", () => {
  const { group, allocations } = plannedGroup(Date.now() - 5000);
  let execCalls = 0;

  const ns = fakeNs({
    exec: () => {
      execCalls++;
      return 1;
    },
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /lead/);
  assert.equal(execCalls, 0);
});

test("the home reserve is honoured at commit time", () => {
  const ledger = createLedger(
    snapshotRunners([{ host: "home", maxRam: 100, usedRam: 0 }], CONFIG),
  );
  const group = planBatchGroup({
    target: "n00dles",
    batch: BATCH,
    workers: WORKERS,
    config: CONFIG,
    batchCount: 1,
    groupId: "mm-b1-n00dles",
    plannedAt: Date.now(),
  });
  const allocation = allocateJobs(ledger, group.jobs);

  // 100 GB max, 43 used, 8 reserved leaves 49 GB — under the 48.75 GB batch by
  // less than the reserve, so the reserve is what makes this fail.
  const ns = fakeNs({
    getServerMaxRam: () => 100,
    getServerUsedRam: () => 43.5,
  });

  const result = commitGroup(
    ns,
    group,
    allocation.allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /free RAM changed/);
});

test("a commit is refused when the target generation changed", () => {
  const { group, allocations } = plannedGroup();
  let execCalls = 0;
  const ns = fakeNs({
    exec: () => {
      execCalls++;
      return 1;
    },
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration + 1,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /generation moved/);
  assert.equal(execCalls, 0);
});

test("a commit is refused when target readiness changed", () => {
  const { group, allocations } = plannedGroup();
  const ns = fakeNs({
    getServer: () => ({
      hasAdminRights: true,
      purchasedByPlayer: false,
      moneyAvailable: 100,
      moneyMax: 1_000_000,
      hackDifficulty: 1,
      minDifficulty: 1,
    }),
  });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /target state moved/);
});

test("a commit is refused when worker files disappeared", () => {
  const { group, allocations } = plannedGroup();
  const ns = fakeNs({ fileExists: () => false });

  const result = commitGroup(
    ns,
    group,
    allocations,
    CONFIG,
    group.targetGeneration,
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /worker files changed/);
});

// -----------------------------------------------------------------------------
// Reconciliation
// -----------------------------------------------------------------------------

test("receipts that vanish early are reported as lost", () => {
  const { group, allocations } = plannedGroup();
  const now = Date.now();
  const inFlight = publishGroup(
    createInFlightLedger(),
    group,
    allocations,
    allocations.map((_, index) => 100 + index),
    now,
  );

  const ns = fakeNs({ isRunning: () => false });
  const result = pollReceipts(ns, inFlight, CONFIG, now);

  assert.equal(result.changed.length, inFlight.receipts.length);
  for (const receipt of result.ledger.receipts) {
    assert.equal(receipt.status, RECEIPT_STATUS.LOST);
  }
});

test("receipts still running before their expected end stay launched", () => {
  const { group, allocations } = plannedGroup();
  const now = Date.now();
  const inFlight = publishGroup(
    createInFlightLedger(),
    group,
    allocations,
    allocations.map((_, index) => 100 + index),
    now,
  );

  const result = pollReceipts(fakeNs(), inFlight, CONFIG, now + 100);

  assert.equal(result.changed.length, 0);
});

test("a receipt running past its late tolerance is marked late", () => {
  const { group, allocations } = plannedGroup();
  const now = Date.now();
  const inFlight = publishGroup(
    createInFlightLedger(),
    group,
    allocations,
    allocations.map((_, index) => 100 + index),
    now,
  );

  const latest = Math.max(...inFlight.receipts.map((r) => r.expectedEndAt));
  const result = pollReceipts(
    fakeNs(),
    inFlight,
    CONFIG,
    latest + CONFIG.lateToleranceMs + 1,
  );

  for (const receipt of result.ledger.receipts) {
    assert.equal(receipt.status, RECEIPT_STATUS.LATE);
  }
});

test("receipt polling skips future completions between full sweeps", () => {
  const { group, allocations } = plannedGroup();
  const now = Date.now();
  const inFlight = publishGroup(
    createInFlightLedger(),
    group,
    allocations,
    allocations.map((_, index) => 100 + index),
    now,
  );
  let polls = 0;
  const ns = fakeNs({
    isRunning: () => {
      polls++;
      return true;
    },
  });

  pollReceipts(ns, inFlight, CONFIG, now + 100, false);
  assert.equal(polls, 0);

  pollReceipts(ns, inFlight, CONFIG, now + 100, true);
  assert.equal(polls, inFlight.receipts.length);
});

test("runner reads use cached worker availability without file probes", () => {
  let fileChecks = 0;
  const ns = fakeNs({
    fileExists: () => {
      fileChecks++;
      return true;
    },
  });

  const runners = readRunners(
    ns,
    ["home", "alpha"],
    new Set(["home", "alpha"]),
  );

  assert.equal(runners.length, 2);
  assert.equal(fileChecks, 0);
  assert.equal(
    runners.every((runner) => runner.workersAvailable),
    true,
  );
});

// -----------------------------------------------------------------------------
// Startup scans
// -----------------------------------------------------------------------------

test("recovery finds only workers this manager tagged", () => {
  const ns = fakeNs({
    ps: () => [
      {
        filename: "worker-hack.ts",
        pid: 5,
        args: ["n00dles", 0, 0, "mm-b1-n00dles-0", "H"],
      },
      {
        filename: "worker-grow.ts",
        pid: 6,
        args: ["joesguns", 0, 0, "other-tool-7", "G"],
      },
      {
        filename: "worker-weaken.ts",
        pid: 7,
        args: ["n00dles", 0, 0, "mm-p2-n00dles-0", "PREP-W"],
      },
      { filename: "some-other.ts", pid: 8, args: [] },
    ],
  });

  const found = recoverTaggedProcesses(ns, ["home"], CONFIG);

  assert.deepEqual(
    found.map((entry) => entry.pid),
    [5, 7],
  );
  assert.deepEqual(
    found.map((entry) => entry.target),
    ["n00dles", "n00dles"],
  );
});

test("the fallback manager is detected and never killed", () => {
  const ns = fakeNs({
    ps: () => [{ filename: "manager.ts", pid: 9, args: [] }],
  });
  const conflict = detectConflictingManager(ns);

  assert.match(conflict, /manager\.ts/);
});

test("a second copy of this manager is detected", () => {
  const ns = fakeNs({
    pid: 1,
    ps: () => [{ filename: "multi-manager.ts", pid: 2, args: [] }],
  });

  assert.match(detectConflictingManager(ns), /already running/);
});

test("our own process is not mistaken for a conflict", () => {
  const ns = fakeNs({
    pid: 1,
    ps: () => [{ filename: "multi-manager.ts", pid: 1, args: [] }],
  });

  assert.equal(detectConflictingManager(ns), null);
});
