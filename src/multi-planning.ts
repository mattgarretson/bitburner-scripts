/**
 * multi-planning.ts — pure job timing, global RAM allocation, and in-flight
 * accounting for the multi-target scheduler.
 *
 * This module never touches Netscript. Every input is plain data produced by
 * multi-runtime.ts, so all of it is testable under `node --test`.
 *
 * RAM is handled internally in integer hundredths of a GB ("units"). Bitburner
 * script costs are multiples of 0.05 GB, so this removes the floating-point
 * boundary cases that make `free >= cost` comparisons unreliable.
 */

/** Hundredths of a GB per GB. */
export const RAM_SCALE = 100;

/** Structured allocation rejections, before purpose-specific mapping. */
export const REJECTION = {
  INSUFFICIENT_TOTAL_RAM: "INSUFFICIENT_TOTAL_RAM",
  RUNNER_FRAGMENTATION: "RUNNER_FRAGMENTATION",
  BELOW_SMALLEST_THREAD: "BELOW_SMALLEST_THREAD",
  WORKERS_NOT_DEPLOYED: "WORKERS_NOT_DEPLOYED",
  INVALID_PLAN: "INVALID_PLAN",
} as const;

/** Displayable idle reason codes from the design document. */
export const IDLE_REASON = {
  NO_ELIGIBLE_TARGETS: "NO_ELIGIBLE_TARGETS",
  ALL_TARGETS_BUSY: "ALL_TARGETS_BUSY",
  WAITING_FOR_OBSERVATION: "WAITING_FOR_OBSERVATION",
  NO_PROFITABLE_BATCH: "NO_PROFITABLE_BATCH",
  COMPLETE_BATCH_TOO_LARGE: "COMPLETE_BATCH_TOO_LARGE",
  PREP_GROUP_TOO_LARGE: "PREP_GROUP_TOO_LARGE",
  RUNNER_FRAGMENTATION: "RUNNER_FRAGMENTATION",
  RESERVED_FOR_BATCH_WINDOW: "RESERVED_FOR_BATCH_WINDOW",
  WORKERS_NOT_DEPLOYED: "WORKERS_NOT_DEPLOYED",
  STALE_SNAPSHOT: "STALE_SNAPSHOT",
  LAUNCH_BACKOFF: "LAUNCH_BACKOFF",
  CONFLICTING_MANAGER: "CONFLICTING_MANAGER",
  BELOW_SMALLEST_THREAD: "BELOW_SMALLEST_THREAD",
} as const;

/** Receipt lifecycle states. */
export const RECEIPT_STATUS = {
  LAUNCHED: "launched",
  FINISHED_UNVERIFIED: "finished-unverified",
  LOST: "lost",
  LATE: "late",
  KILLED: "killed",
} as const;

export const DEFAULT_CONFIG = {
  tagPrefix: "mm",
  homeReserve: 8,
  landingGap: 200,
  launchLead: 1_000,
  maxBatches: 20,
  securityTolerance: 0.02,
  moneyReadyRatio: 0.999,
  completionBuffer: 250,
  observationTtlMs: 5_000,
  settleBufferMs: 250,
  backoffMs: 5_000,
  lateToleranceMs: 2_000,
  earlyToleranceMs: 500,
  prepAgingMs: 60_000,
  growSafetyMargin: 0.02,
} as const;

export type Operation = "hack" | "grow" | "weaken";
export type GroupPurpose = "batch" | "money-prep" | "security-prep";
export type ReceiptStatus =
  (typeof RECEIPT_STATUS)[keyof typeof RECEIPT_STATUS];
export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];
export type IdleReasonCode = (typeof IDLE_REASON)[keyof typeof IDLE_REASON];

/** Anything displayable as the cause of unallocated RAM. */
export type ReasonCode = RejectionCode | IdleReasonCode;

export type SchedulerConfig = {
  tagPrefix?: string;
  homeReserve: number;
  landingGap: number;
  launchLead: number;
  maxBatches: number;
  securityTolerance?: number;
  moneyReadyRatio?: number;
  completionBuffer?: number;
  observationTtlMs?: number;
  settleBufferMs?: number;
  backoffMs?: number;
  lateToleranceMs?: number;
  earlyToleranceMs?: number;
  prepAgingMs?: number;
  growSafetyMargin?: number;
  launchSafetyMs?: number;
  hackFraction?: number;
  minimumHackFraction?: number;
};

export type RunnerInput = {
  host: string;
  maxRam: number;
  usedRam: number;
  workersAvailable?: boolean;
};

export type RunnerSnapshot = {
  host: string;
  maxRam: number;
  usedRam: number;
  homeReserve: number;
  allocatableRam: number;
  allocatableUnits: number;
  workersAvailable: boolean;
};

export type SizingCapacityInput = {
  host: string;
  maxRam: number;
  foreignUsedRam: number;
  workersAvailable: boolean;
};

export type LedgerEntry = {
  host: string;
  units: number;
  nominalUnits: number;
  workersAvailable: boolean;
};

export type Ledger = { entries: LedgerEntry[] };
export type WorkerCost = { file: string; ram: number };
export type WorkerCosts = Record<Operation, WorkerCost>;

export type BatchSpec = {
  hackThreads: number;
  growThreads: number;
  weakenHackThreads: number;
  weakenGrowThreads: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
  expectedMoney: number;
};

export type PrepSpec = {
  growThreads: number;
  weakenThreads: number;
  growTime: number;
  weakenTime: number;
};

export type MoneyPrepSpec = {
  growThreadsNeeded: number;
  growSecurityPerThread: number;
  weakenPerThread: number;
  growTime: number;
  weakenTime: number;
  baseWeakenThreads?: number;
};

export type SecurityPrepSpec = {
  threadsNeeded: number;
  weakenTime: number;
};

export type LogicalJob = {
  id: string;
  groupId: string;
  batchId: string;
  target: string;
  operation: Operation;
  script: string;
  ramPerThread: number;
  threads: number;
  delay: number;
  duration: number;
  label: string;
};

export type JobGroup = {
  id: string;
  purpose: GroupPurpose;
  target: string;
  targetGeneration: number;
  plannedAt: number;
  jobs: LogicalJob[];
  batchCount: number;
  expectedValue: number;
  expectedLastEndAt: number;
  continuation: boolean;
};

export type Fragment = {
  groupId: string;
  logicalJobId: string;
  batchId: string;
  target: string;
  operation: Operation;
  script: string;
  host: string;
  threads: number;
  ramPerThread: number;
  units: number;
  delay: number;
  duration: number;
  label: string;
  args: Array<string | number>;
};

export type Rejection = {
  code: ReasonCode;
  requiredUnits: number;
  availableUnits: number;
  shortfallUnits: number;
  blockedUnits: number;
  largestHostUnits: number;
  smallestThreadUnits: number;
  detail?: string;
};

export type AllocationSuccess = {
  ok: true;
  allocations: Fragment[];
  ledger: Ledger;
  unitsAllocated: number;
};

export type AllocationFailure = { ok: false; rejection: Rejection };
export type AllocationResult = AllocationSuccess | AllocationFailure;

type MakeJobInput = Omit<LogicalJob, "id" | "script" | "ramPerThread"> & {
  worker: WorkerCost;
};

type MakeGroupInput = Omit<JobGroup, "expectedLastEndAt">;

export type PlanBatchGroupInput = {
  target: string;
  batch: BatchSpec;
  workers: WorkerCosts;
  config: SchedulerConfig;
  batchCount: number;
  groupId: string;
  targetGeneration?: number;
  plannedAt?: number;
  batchIndexStart?: number;
  landingOffset?: number;
  continuation?: boolean;
};

export type PlanMoneyPrepGroupInput = {
  target: string;
  prep: PrepSpec;
  workers: WorkerCosts;
  config: SchedulerConfig;
  groupId: string;
  targetGeneration?: number;
  plannedAt?: number;
  purpose?: "money-prep" | "security-prep";
};

export type PlanSecurityPrepGroupInput = {
  target: string;
  threads: number;
  weakenTime: number;
  workers: WorkerCosts;
  config: SchedulerConfig;
  groupId: string;
  targetGeneration?: number;
  plannedAt?: number;
};

export type PlanLargestWaveInput = Omit<PlanBatchGroupInput, "batchCount"> & {
  ledger: Ledger;
  maxBatches?: number;
};

export type PlanLargestMoneyPrepInput = Omit<
  PlanMoneyPrepGroupInput,
  "prep"
> & {
  prep: MoneyPrepSpec;
  ledger: Ledger;
};

export type PlanLargestSecurityPrepInput = Omit<
  PlanSecurityPrepGroupInput,
  "threads" | "weakenTime"
> & {
  prep: SecurityPrepSpec;
  ledger: Ledger;
};

export type WavePlanResult =
  | {
      ok: true;
      group: JobGroup;
      allocations: Fragment[];
      ledger: Ledger;
      batchCount: number;
    }
  | AllocationFailure;

export type MoneyPrepPlanResult =
  | {
      ok: true;
      group: JobGroup;
      allocations: Fragment[];
      ledger: Ledger;
      growThreads: number;
      weakenThreads: number;
    }
  | AllocationFailure;

export type SecurityPrepPlanResult =
  | {
      ok: true;
      group: JobGroup;
      allocations: Fragment[];
      ledger: Ledger;
      threads: number;
    }
  | AllocationFailure;

export type Receipt = {
  receiptId: string;
  groupId: string;
  logicalJobId: string;
  target: string;
  operation: Operation;
  runner: string;
  threads: number;
  units: number;
  pid: number;
  plannedAt: number;
  expectedStartAt: number;
  expectedEndAt: number;
  status: ReceiptStatus;
};

export type GroupFault = {
  lost: number;
  late: number;
  killed: number;
  firstFaultAt: number;
};

export type InFlightLedger = {
  receipts: Receipt[];
  groupFaults: Record<string, GroupFault>;
};
export type ReleaseEvent = { at: number; units: number };

// -----------------------------------------------------------------------------
// Unit helpers
// -----------------------------------------------------------------------------

export function toUnits(gb: number): number {
  return Math.round(gb * RAM_SCALE);
}

export function fromUnits(units: number): number {
  return units / RAM_SCALE;
}

// -----------------------------------------------------------------------------
// Runner snapshot and private ledger
// -----------------------------------------------------------------------------

/**
 * The home reserve is removed here, before any planning sees the RAM. Every
 * other rooted runner uses a zero reserve.
 */
export function snapshotRunners(
  runners: RunnerInput[],
  config: SchedulerConfig,
): RunnerSnapshot[] {
  const reserve = Math.max(0, config.homeReserve || 0);

  return runners.map((runner) => {
    const homeReserve = runner.host === "home" ? reserve : 0;
    const allocatableRam = Math.max(
      0,
      runner.maxRam - runner.usedRam - homeReserve,
    );

    return {
      host: runner.host,
      maxRam: runner.maxRam,
      usedRam: runner.usedRam,
      homeReserve,
      allocatableRam,
      allocatableUnits: Math.max(0, toUnits(allocatableRam)),
      workersAvailable: runner.workersAvailable !== false,
    };
  });
}

export function stableSizingCapacity(
  runners: SizingCapacityInput[],
  homeReserve: number,
): number {
  return runners.reduce((sum, runner) => {
    if (!runner.workersAvailable) return sum;
    const reserve = runner.host === "home" ? Math.max(0, homeReserve) : 0;
    return (
      sum +
      Math.max(0, runner.maxRam - reserve - Math.max(0, runner.foreignUsedRam))
    );
  }, 0);
}

/**
 * Runners missing worker files contribute zero allocatable RAM but keep their
 * nominal RAM so idle reporting can blame WORKERS_NOT_DEPLOYED.
 */
export function createLedger(snapshots: RunnerSnapshot[]): Ledger {
  return {
    entries: snapshots.map((snapshot) => ({
      host: snapshot.host,
      units: snapshot.workersAvailable ? snapshot.allocatableUnits : 0,
      nominalUnits: snapshot.allocatableUnits,
      workersAvailable: snapshot.workersAvailable,
    })),
  };
}

export function totalUnits(ledger: Ledger): number {
  return ledger.entries.reduce((sum, entry) => sum + entry.units, 0);
}

export function blockedUnits(ledger: Ledger): number {
  return ledger.entries.reduce(
    (sum, entry) => sum + (entry.workersAvailable ? 0 : entry.nominalUnits),
    0,
  );
}

export function largestHostUnits(ledger: Ledger): number {
  return ledger.entries.reduce(
    (largest, entry) => Math.max(largest, entry.units),
    0,
  );
}

// -----------------------------------------------------------------------------
// Job and group construction
// -----------------------------------------------------------------------------

function makeJob(input: MakeJobInput): LogicalJob {
  const delay = Math.max(0, Math.floor(input.delay));

  return {
    id: `${input.batchId}-${input.label}`,
    groupId: input.groupId,
    batchId: input.batchId,
    target: input.target,
    operation: input.operation,
    script: input.worker.file,
    ramPerThread: input.worker.ram,
    threads: Math.max(0, Math.floor(input.threads)),
    delay,
    duration: Math.max(0, input.duration),
    label: input.label,
  };
}

function makeGroup(input: MakeGroupInput): JobGroup {
  const lastEnd = input.jobs.reduce(
    (latest, job) => Math.max(latest, job.delay + job.duration),
    0,
  );

  return {
    id: input.id,
    purpose: input.purpose,
    target: input.target,
    targetGeneration: input.targetGeneration,
    plannedAt: input.plannedAt,
    jobs: input.jobs,
    batchCount: input.batchCount,
    expectedValue: input.expectedValue,
    expectedLastEndAt: input.plannedAt + lastEnd,
    continuation: input.continuation,
  };
}

/**
 * Build a complete H/W1/G/W2 wave. Landing order is enforced by delay maths:
 * each operation lands one landing gap after the previous one.
 */
export function planBatchGroup(input: PlanBatchGroupInput): JobGroup {
  const { target, batch, workers, config, batchCount, groupId } = input;
  const spacing = 4 * config.landingGap;
  const batchIndexStart = Math.max(0, Math.floor(input.batchIndexStart ?? 0));
  const landingOffset = Math.max(0, input.landingOffset ?? 0);
  const jobs: LogicalJob[] = [];

  for (let localIndex = 0; localIndex < batchCount; localIndex++) {
    const index = batchIndexStart + localIndex;
    const offset = landingOffset + localIndex * spacing;
    const batchId = `${groupId}-${index}`;

    jobs.push(
      makeJob({
        groupId,
        batchId,
        target,
        operation: "hack",
        worker: workers.hack,
        threads: batch.hackThreads,
        delay:
          config.launchLead +
          Math.max(0, batch.weakenTime - batch.hackTime) +
          offset,
        duration: batch.hackTime,
        label: "H",
      }),
      makeJob({
        groupId,
        batchId,
        target,
        operation: "weaken",
        worker: workers.weaken,
        threads: batch.weakenHackThreads,
        delay: config.launchLead + config.landingGap + offset,
        duration: batch.weakenTime,
        label: "W1",
      }),
      makeJob({
        groupId,
        batchId,
        target,
        operation: "grow",
        worker: workers.grow,
        threads: batch.growThreads,
        delay:
          config.launchLead +
          Math.max(0, batch.weakenTime - batch.growTime) +
          2 * config.landingGap +
          offset,
        duration: batch.growTime,
        label: "G",
      }),
      makeJob({
        groupId,
        batchId,
        target,
        operation: "weaken",
        worker: workers.weaken,
        threads: batch.weakenGrowThreads,
        delay: config.launchLead + 3 * config.landingGap + offset,
        duration: batch.weakenTime,
        label: "W2",
      }),
    );
  }

  return makeGroup({
    id: groupId,
    purpose: "batch",
    target,
    targetGeneration: input.targetGeneration ?? 0,
    plannedAt: input.plannedAt ?? 0,
    jobs,
    batchCount,
    expectedValue: batch.expectedMoney * batchCount,
    continuation: input.continuation ?? false,
  });
}

/**
 * Money prep is always grow plus its compensating weaken. Never one without
 * the other.
 */
export function planMoneyPrepGroup(input: PlanMoneyPrepGroupInput): JobGroup {
  const { target, prep, workers, config, groupId } = input;
  const batchId = `${groupId}-0`;

  const jobs = [
    makeJob({
      groupId,
      batchId,
      target,
      operation: "grow",
      worker: workers.grow,
      threads: prep.growThreads,
      delay: config.launchLead + Math.max(0, prep.weakenTime - prep.growTime),
      duration: prep.growTime,
      label: "PREP-G",
    }),
    makeJob({
      groupId,
      batchId,
      target,
      operation: "weaken",
      worker: workers.weaken,
      threads: prep.weakenThreads,
      delay: config.launchLead + config.landingGap,
      duration: prep.weakenTime,
      label: "PREP-W",
    }),
  ];

  return makeGroup({
    id: groupId,
    purpose: input.purpose ?? "money-prep",
    target,
    targetGeneration: input.targetGeneration ?? 0,
    plannedAt: input.plannedAt ?? 0,
    jobs,
    batchCount: 0,
    expectedValue: 0,
    continuation: false,
  });
}

export function planSecurityPrepGroup(
  input: PlanSecurityPrepGroupInput,
): JobGroup {
  const { target, workers, config, groupId } = input;
  const batchId = `${groupId}-0`;

  const jobs = [
    makeJob({
      groupId,
      batchId,
      target,
      operation: "weaken",
      worker: workers.weaken,
      threads: input.threads,
      delay: config.launchLead,
      duration: input.weakenTime,
      label: "PREP-W",
    }),
  ];

  return makeGroup({
    id: groupId,
    purpose: "security-prep",
    target,
    targetGeneration: input.targetGeneration ?? 0,
    plannedAt: input.plannedAt ?? 0,
    jobs,
    batchCount: 0,
    expectedValue: 0,
    continuation: false,
  });
}

/**
 * Structural completeness check. A batch group must carry H, W1, G and W2 for
 * every batch it claims; a money-prep group must carry grow and weaken.
 */
export function validateGroup(group: JobGroup): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];

  for (const job of group.jobs) {
    if (job.threads < 1) problems.push(`${job.id} has ${job.threads} threads`);
  }

  if (group.purpose === "batch") {
    if (group.batchCount < 1) problems.push("batch group has no batches");

    const byBatch = new Map<string, string[]>();
    for (const job of group.jobs) {
      const labels = byBatch.get(job.batchId) ?? [];
      labels.push(job.label);
      byBatch.set(job.batchId, labels);
    }

    if (byBatch.size !== group.batchCount) {
      problems.push(
        `expected ${group.batchCount} batches, found ${byBatch.size}`,
      );
    }

    for (const [batchId, labels] of byBatch) {
      for (const required of ["H", "W1", "G", "W2"]) {
        if (!labels.includes(required))
          problems.push(`${batchId} is missing ${required}`);
      }
    }
  }

  if (group.purpose === "money-prep") {
    const operations = group.jobs.map((job) => job.operation);
    if (!operations.includes("grow"))
      problems.push("money prep is missing grow");
    if (!operations.includes("weaken"))
      problems.push("money prep is missing its weaken");
  }

  return { ok: problems.length === 0, problems };
}

export function requiredUnits(jobs: LogicalJob[]): number {
  return jobs.reduce(
    (sum, job) => sum + toUnits(job.ramPerThread) * job.threads,
    0,
  );
}

// -----------------------------------------------------------------------------
// Allocation
// -----------------------------------------------------------------------------

function compareJobsForAllocation(a: LogicalJob, b: LogicalJob): number {
  return (
    b.ramPerThread - a.ramPerThread ||
    b.threads - a.threads ||
    a.delay - b.delay ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * `home` is always placed last so its RAM stays available for anything the
 * player runs manually. Everything else is largest-free-first, then hostname
 * for determinism.
 */
function compareHostsForPlacement(a: LedgerEntry, b: LedgerEntry): number {
  if (a.host === "home" && b.host !== "home") return 1;
  if (b.host === "home" && a.host !== "home") return -1;
  return b.units - a.units || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
}

function insertHostForPlacement(
  ordered: LedgerEntry[],
  entry: LedgerEntry,
): void {
  let low = 0;
  let high = ordered.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareHostsForPlacement(ordered[middle], entry) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  ordered.splice(low, 0, entry);
}

/**
 * Allocate every thread of every job against a private copy of the ledger.
 *
 * A successful result means every thread has a home. A failure leaves the input
 * ledger untouched and explains why nothing was placed.
 */
export function allocateJobs(
  ledger: Ledger,
  jobs: LogicalJob[],
): AllocationResult {
  const working = ledger.entries.map((entry) => ({ ...entry }));
  const allocations: Fragment[] = [];
  let unitsAllocated = 0;

  for (const job of jobs) {
    if (!Number.isFinite(job.threads) || job.threads < 1) {
      return {
        ok: false,
        rejection: describeShortage(
          ledger,
          jobs,
          REJECTION.INVALID_PLAN,
          `${job.id} requests ${job.threads} threads`,
        ),
      };
    }
    if (!Number.isFinite(job.ramPerThread) || job.ramPerThread <= 0) {
      return {
        ok: false,
        rejection: describeShortage(
          ledger,
          jobs,
          REJECTION.INVALID_PLAN,
          `${job.id} has no RAM cost`,
        ),
      };
    }
  }

  const ordered = [...jobs].sort(compareJobsForAllocation);
  const hosts = [...working].sort(compareHostsForPlacement);

  for (const job of ordered) {
    const unitCost = toUnits(job.ramPerThread);
    let remaining = job.threads;

    let hostIndex = 0;
    while (remaining > 0 && hostIndex < hosts.length) {
      const entry = hosts[hostIndex];
      const capacity = Math.floor(entry.units / unitCost);
      const threads = Math.min(remaining, capacity);
      if (threads < 1) {
        hostIndex++;
        continue;
      }

      allocations.push({
        groupId: job.groupId,
        logicalJobId: job.id,
        batchId: job.batchId,
        target: job.target,
        operation: job.operation,
        script: job.script,
        host: entry.host,
        threads,
        ramPerThread: job.ramPerThread,
        units: threads * unitCost,
        delay: job.delay,
        duration: job.duration,
        label: job.label,
        args: [job.target, job.delay, 0, job.batchId, job.label],
      });

      entry.units -= threads * unitCost;
      unitsAllocated += threads * unitCost;
      remaining -= threads;

      hosts.splice(hostIndex, 1);
      insertHostForPlacement(hosts, entry);
      hostIndex = 0;
    }

    if (remaining > 0) {
      return {
        ok: false,
        rejection: describeShortage(
          ledger,
          jobs,
          null,
          `${job.id} could not place ${remaining} thread(s)`,
        ),
      };
    }
  }

  return {
    ok: true,
    allocations,
    ledger: { entries: working },
    unitsAllocated,
  };
}

function describeShortage(
  ledger: Ledger,
  jobs: LogicalJob[],
  forcedCode: RejectionCode | null,
  detail: string,
): Rejection {
  const required = requiredUnits(jobs);
  const available = totalUnits(ledger);
  const blocked = blockedUnits(ledger);
  const largest = largestHostUnits(ledger);
  const smallestThread = jobs.reduce(
    (smallest, job) => Math.min(smallest, toUnits(job.ramPerThread)),
    Number.POSITIVE_INFINITY,
  );

  let code: RejectionCode = forcedCode ?? REJECTION.RUNNER_FRAGMENTATION;

  if (forcedCode === null) {
    if (blocked > 0 && available + blocked >= required) {
      code = REJECTION.WORKERS_NOT_DEPLOYED;
    } else if (available < required) {
      code = REJECTION.INSUFFICIENT_TOTAL_RAM;
    } else if (largest < smallestThread) {
      code = REJECTION.BELOW_SMALLEST_THREAD;
    } else {
      code = REJECTION.RUNNER_FRAGMENTATION;
    }
  }

  return {
    code,
    requiredUnits: required,
    availableUnits: available,
    shortfallUnits: Math.max(0, required - available),
    blockedUnits: blocked,
    largestHostUnits: largest,
    smallestThreadUnits: Number.isFinite(smallestThread) ? smallestThread : 0,
    detail,
  };
}

export function mapRejection(
  rejection: Rejection,
  purpose: "batch" | "prep",
): Rejection {
  if (rejection.code !== REJECTION.INSUFFICIENT_TOTAL_RAM) {
    return rejection;
  }

  return {
    ...rejection,
    code:
      purpose === "batch"
        ? IDLE_REASON.COMPLETE_BATCH_TOO_LARGE
        : IDLE_REASON.PREP_GROUP_TOO_LARGE,
  };
}

/**
 * Binary-search the largest wave that fits. A wave only ever shrinks by whole
 * batches, so a returned group is always complete.
 */
export function planLargestWave(input: PlanLargestWaveInput): WavePlanResult {
  const maxBatches = Math.max(
    1,
    Math.floor(input.maxBatches ?? input.config.maxBatches),
  );
  let low = 1;
  let high = maxBatches;
  let best: Omit<Extract<WavePlanResult, { ok: true }>, "ok"> | null = null;

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const group = planBatchGroup({ ...input, batchCount: count });
    const result = allocateJobs(input.ledger, group.jobs);

    if (result.ok) {
      best = {
        group,
        allocations: result.allocations,
        ledger: result.ledger,
        batchCount: count,
      };
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  if (best) return { ok: true, ...best };

  // Report against the smallest possible complete wave, not the last probe.
  const single = planBatchGroup({ ...input, batchCount: 1 });
  const failure = allocateJobs(input.ledger, single.jobs);
  const rejection = failure.ok
    ? describeShortage(
        input.ledger,
        single.jobs,
        REJECTION.INVALID_PLAN,
        "wave search failed but one batch fits",
      )
    : failure.rejection;

  return { ok: false, rejection: mapRejection(rejection, "batch") };
}

/**
 * Grow security scales linearly with thread count, so the runtime hands over
 * per-thread constants once and the planner can size the compensating weaken
 * for any grow thread count without calling Netscript.
 */
export function weakenThreadsForGrowThreads(
  growThreads: number,
  spec: MoneyPrepSpec,
): number {
  const security = growThreads * spec.growSecurityPerThread;
  return (
    Math.max(0, Math.floor(spec.baseWeakenThreads ?? 0)) +
    Math.max(1, Math.ceil(security / Math.max(1e-9, spec.weakenPerThread)))
  );
}

/**
 * Largest grow + compensating weaken pair that fits.
 *
 * Unlike a batch, prep may make partial progress toward a prepared target, so
 * the size shrinks to fit. The grow/weaken pair itself is never split up.
 */
export function planLargestMoneyPrep(
  input: PlanLargestMoneyPrepInput,
): MoneyPrepPlanResult {
  const needed = Math.max(1, Math.floor(input.prep.growThreadsNeeded));
  let low = 1;
  let high = needed;
  let best: Omit<Extract<MoneyPrepPlanResult, { ok: true }>, "ok"> | null =
    null;

  while (low <= high) {
    const growThreads = Math.floor((low + high) / 2);
    const weakenThreads = weakenThreadsForGrowThreads(growThreads, input.prep);
    const group = planMoneyPrepGroup({
      ...input,
      prep: {
        growThreads,
        weakenThreads,
        growTime: input.prep.growTime,
        weakenTime: input.prep.weakenTime,
      },
    });
    const result = allocateJobs(input.ledger, group.jobs);

    if (result.ok) {
      best = {
        group,
        allocations: result.allocations,
        ledger: result.ledger,
        growThreads,
        weakenThreads,
      };
      low = growThreads + 1;
    } else {
      high = growThreads - 1;
    }
  }

  if (best) return { ok: true, ...best };

  const single = planMoneyPrepGroup({
    ...input,
    prep: {
      growThreads: 1,
      weakenThreads: weakenThreadsForGrowThreads(1, input.prep),
      growTime: input.prep.growTime,
      weakenTime: input.prep.weakenTime,
    },
  });
  const failure = allocateJobs(input.ledger, single.jobs);
  const rejection = failure.ok
    ? describeShortage(
        input.ledger,
        single.jobs,
        REJECTION.INVALID_PLAN,
        "prep search failed but one grow pair fits",
      )
    : failure.rejection;

  return { ok: false, rejection: mapRejection(rejection, "prep") };
}

/**
 * Largest weaken that fits, capped at what the target actually needs. Security
 * prep is allowed to make partial progress.
 */
export function planLargestSecurityPrep(
  input: PlanLargestSecurityPrepInput,
): SecurityPrepPlanResult {
  const needed = Math.max(1, Math.floor(input.prep.threadsNeeded));
  let low = 1;
  let high = needed;
  let best: Omit<Extract<SecurityPrepPlanResult, { ok: true }>, "ok"> | null =
    null;

  while (low <= high) {
    const threads = Math.floor((low + high) / 2);
    const group = planSecurityPrepGroup({
      ...input,
      threads,
      weakenTime: input.prep.weakenTime,
    });
    const result = allocateJobs(input.ledger, group.jobs);

    if (result.ok) {
      best = {
        group,
        allocations: result.allocations,
        ledger: result.ledger,
        threads,
      };
      low = threads + 1;
    } else {
      high = threads - 1;
    }
  }

  if (best) return { ok: true, ...best };

  const single = planSecurityPrepGroup({
    ...input,
    threads: 1,
    weakenTime: input.prep.weakenTime,
  });
  const failure = allocateJobs(input.ledger, single.jobs);
  const rejection = failure.ok
    ? describeShortage(
        input.ledger,
        single.jobs,
        REJECTION.INVALID_PLAN,
        "prep search failed but one weaken thread fits",
      )
    : failure.rejection;

  return { ok: false, rejection: mapRejection(rejection, "prep") };
}

// -----------------------------------------------------------------------------
// In-flight receipt ledger
// -----------------------------------------------------------------------------

export function createInFlightLedger(): InFlightLedger {
  return { receipts: [], groupFaults: {} };
}

/** Receipts are published only after a whole group launches. */
export function publishGroup(
  ledger: InFlightLedger,
  group: JobGroup,
  allocations: Fragment[],
  pids: number[],
  plannedAt: number,
): InFlightLedger {
  const receipts = allocations.map((fragment, index) => ({
    receiptId: `${group.id}:${fragment.logicalJobId}:${fragment.host}:${index}`,
    groupId: group.id,
    logicalJobId: fragment.logicalJobId,
    target: fragment.target,
    operation: fragment.operation,
    runner: fragment.host,
    threads: fragment.threads,
    units: fragment.units,
    pid: pids[index] ?? 0,
    plannedAt,
    expectedStartAt: plannedAt,
    expectedEndAt: plannedAt + fragment.delay + fragment.duration,
    status: RECEIPT_STATUS.LAUNCHED,
  }));

  return {
    receipts: [...ledger.receipts, ...receipts],
    groupFaults: ledger.groupFaults,
  };
}

export function isLiveStatus(status: ReceiptStatus): boolean {
  return status === RECEIPT_STATUS.LAUNCHED || status === RECEIPT_STATUS.LATE;
}

export function receiptsForTarget(
  ledger: InFlightLedger,
  host: string,
): Receipt[] {
  return ledger.receipts.filter((receipt) => receipt.target === host);
}

/** A target stays locked while any of its receipts is still live. */
export function targetHasLiveReceipts(
  ledger: InFlightLedger,
  host: string,
): boolean {
  return ledger.receipts.some(
    (receipt) => receipt.target === host && isLiveStatus(receipt.status),
  );
}

export function ramInFlightUnits(ledger: InFlightLedger): number {
  return ledger.receipts.reduce(
    (sum, receipt) => sum + (isLiveStatus(receipt.status) ? receipt.units : 0),
    0,
  );
}

/**
 * Pure reconciliation. The caller supplies liveness from ns.isRunning; this
 * decides what that observation means.
 */
export function classifyReceipt(
  receipt: Receipt,
  input: { isRunning: boolean; now: number; config: SchedulerConfig },
): ReceiptStatus {
  const late = input.config.lateToleranceMs ?? DEFAULT_CONFIG.lateToleranceMs;
  const early =
    input.config.earlyToleranceMs ?? DEFAULT_CONFIG.earlyToleranceMs;

  if (input.isRunning) {
    return input.now > receipt.expectedEndAt + late
      ? RECEIPT_STATUS.LATE
      : RECEIPT_STATUS.LAUNCHED;
  }

  return input.now >= receipt.expectedEndAt - early
    ? RECEIPT_STATUS.FINISHED_UNVERIFIED
    : RECEIPT_STATUS.LOST;
}

export function applyReceiptStatus(
  ledger: InFlightLedger,
  receiptId: string,
  status: ReceiptStatus,
  faultAt?: number,
): InFlightLedger {
  const previous = ledger.receipts.find(
    (receipt) => receipt.receiptId === receiptId,
  );
  let groupFaults = ledger.groupFaults;

  if (
    previous &&
    previous.status !== status &&
    (status === RECEIPT_STATUS.LOST ||
      status === RECEIPT_STATUS.LATE ||
      status === RECEIPT_STATUS.KILLED)
  ) {
    const existing = groupFaults[previous.groupId] ?? {
      lost: 0,
      late: 0,
      killed: 0,
      firstFaultAt: faultAt ?? previous.expectedEndAt,
    };
    const key =
      status === RECEIPT_STATUS.LOST
        ? "lost"
        : status === RECEIPT_STATUS.LATE
          ? "late"
          : "killed";
    groupFaults = {
      ...groupFaults,
      [previous.groupId]: {
        ...existing,
        [key]: existing[key] + 1,
        firstFaultAt: Math.min(
          existing.firstFaultAt,
          faultAt ?? previous.expectedEndAt,
        ),
      },
    };
  }

  return {
    receipts: ledger.receipts.map((receipt) =>
      receipt.receiptId === receiptId ? { ...receipt, status } : receipt,
    ),
    groupFaults,
  };
}

export function pruneTerminalReceipts(ledger: InFlightLedger): InFlightLedger {
  return {
    receipts: ledger.receipts.filter((receipt) => isLiveStatus(receipt.status)),
    groupFaults: ledger.groupFaults,
  };
}

export function clearGroupFault(
  ledger: InFlightLedger,
  groupId: string,
): InFlightLedger {
  if (!(groupId in ledger.groupFaults)) return ledger;
  const groupFaults = { ...ledger.groupFaults };
  delete groupFaults[groupId];
  return { receipts: ledger.receipts, groupFaults };
}

/** When each live receipt is expected to give its RAM back, ascending. */
export function releaseCalendar(ledger: InFlightLedger): ReleaseEvent[] {
  return ledger.receipts
    .filter((receipt) => isLiveStatus(receipt.status))
    .map((receipt) => ({ at: receipt.expectedEndAt, units: receipt.units }))
    .sort((a, b) => a.at - b.at);
}

export function unitsReleasedBy(ledger: InFlightLedger, at: number): number {
  return releaseCalendar(ledger)
    .filter((event) => event.at <= at)
    .reduce((sum, event) => sum + event.units, 0);
}

/**
 * Earliest time at which `shortfallUnits` more RAM is expected to be free.
 * Returns null when in-flight work will never cover the shortfall.
 */
export function earliestReleaseTime(
  ledger: InFlightLedger,
  shortfallUnits: number,
): number | null {
  if (shortfallUnits <= 0) return null;

  let accumulated = 0;
  for (const event of releaseCalendar(ledger)) {
    accumulated += event.units;
    if (accumulated >= shortfallUnits) return event.at;
  }

  return null;
}
