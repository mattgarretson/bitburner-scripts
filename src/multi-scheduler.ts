/**
 * multi-scheduler.ts — pure target reducer and scheduling policy.
 *
 * No Netscript. Given target records, a runner snapshot, the in-flight ledger,
 * config and `now`, this returns exactly one decision: a fully allocated batch
 * group, a fully allocated prep group, or an idle decision carrying structured
 * reasons.
 */

import {
  IDLE_REASON,
  createLedger,
  earliestReleaseTime,
  isLiveStatus,
  planLargestMoneyPrep,
  planLargestSecurityPrep,
  planLargestWave,
  requiredUnits,
  targetHasLiveReceipts,
  totalUnits,
  unitsReleasedBy,
} from "./multi-planning.ts";

import type {
  BatchSpec,
  Fragment,
  InFlightLedger,
  JobGroup,
  Ledger,
  MoneyPrepPlanResult,
  MoneyPrepSpec,
  ReasonCode,
  RunnerSnapshot,
  SchedulerConfig,
  SecurityPrepPlanResult,
  SecurityPrepSpec,
  WorkerCosts,
} from "./multi-planning.ts";

export const PHASE = {
  NEEDS_OBSERVATION: "NEEDS_OBSERVATION",
  UNAVAILABLE: "UNAVAILABLE",
  SECURITY_PREP_READY: "SECURITY_PREP_READY",
  MONEY_PREP_READY: "MONEY_PREP_READY",
  BATCH_READY: "BATCH_READY",
  PREP_IN_FLIGHT: "PREP_IN_FLIGHT",
  BATCH_IN_FLIGHT: "BATCH_IN_FLIGHT",
  SETTLING: "SETTLING",
  BACKOFF: "BACKOFF",
} as const;

export type Phase = (typeof PHASE)[keyof typeof PHASE];

export type Observation = {
  valid: boolean;
  observedAt: number;
  money: number;
  maxMoney: number;
  security: number;
  minSecurity: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
  reason?: string;
};

export type TargetEconomics = {
  preparedBatch: BatchSpec | null;
  expectedMoneyPerSecond: number;
  prepPriority?: number;
  moneyPrep?: MoneyPrepSpec | null;
  securityPrep?: SecurityPrepSpec | null;
};

export type TargetRecord = {
  host: string;
  phase: Phase;
  generation: number;
  observation: Observation | null;
  economics: TargetEconomics | null;
  activeGroupId: string | null;
  settleAfter: number;
  backoffUntil: number;
  dirtyReason: string | null;
  waitingSince: number;
  batchTooLargeCount: number;
  batchSizeNotches: number;
  scheduledBatchCount: number;
};

/** Every event `reduceTarget` understands. */
export type TargetEventType =
  | "observed"
  | "group-committed"
  | "receipts-terminal"
  | "settled"
  | "launch-failed"
  | "continuation-failed"
  | "timing-fault"
  | "batch-too-large"
  | "backoff-elapsed";

export type TargetEvent = {
  type: TargetEventType;
  now: number;
  observation?: Observation;
  economics?: TargetEconomics | null;
  groupId?: string;
  purpose?: "batch" | "prep";
  batchCount?: number;
  reason?: string;
};

export type IdleReason = { host: string; code: ReasonCode; detail?: string };

export type Decision =
  | {
      kind: "batch" | "prep";
      group: JobGroup;
      allocations: Fragment[];
      target: string;
      reasons: IdleReason[];
    }
  | {
      kind: "idle";
      dominantReason: ReasonCode;
      reasons: IdleReason[];
      idleUnits: number;
    };

export type DecideInput = {
  targets: TargetRecord[];
  snapshots: RunnerSnapshot[];
  inFlight: InFlightLedger;
  workers: WorkerCosts;
  config: SchedulerConfig;
  now: number;
  serial: number;
  conflictingManager?: boolean;
};

type PrepPlanResult = MoneyPrepPlanResult | SecurityPrepPlanResult | null;
type ContinuationWindow = { lastEndAt: number; launchAt: number };
type BatchCandidate = {
  record: TargetRecord;
  continuation: ContinuationWindow | null;
};

export type BatchWindowInput = {
  prepGroup: JobGroup;
  prepUnits: number;
  pendingBatch: { host: string; requiredUnits: number } | null;
  inFlight: InFlightLedger;
  freeUnits: number;
};

export type BatchWindowResult = { allowed: boolean; detail?: string };

export function canRefill(input: {
  commits: number;
  elapsedMs: number;
  commitCap: number;
  wallClockBudgetMs: number;
}): boolean {
  return (
    input.commits < input.commitCap && input.elapsedMs < input.wallClockBudgetMs
  );
}

export function preparedPrepPriority(
  expectedMoneyPerSecond: number,
  maxMoney: number,
  weakenTime: number,
): number {
  return expectedMoneyPerSecond > 0
    ? expectedMoneyPerSecond
    : Math.max(0, maxMoney) / Math.max(0.001, weakenTime / 1_000);
}

export function createTargetRecord(host: string): TargetRecord {
  return {
    host,
    phase: PHASE.NEEDS_OBSERVATION,
    generation: 0,
    observation: null,
    economics: null,
    activeGroupId: null,
    settleAfter: 0,
    backoffUntil: 0,
    dirtyReason: null,
    waitingSince: 0,
    batchTooLargeCount: 0,
    batchSizeNotches: 0,
    scheduledBatchCount: 0,
  };
}

/**
 * Classification is the only place a phase is derived from server state, and it
 * only ever runs on a fresh observation of a quiescent target.
 */
export function classifyObservation(
  observation: Observation,
  config: SchedulerConfig,
): Phase {
  if (!observation.valid) return PHASE.UNAVAILABLE;

  const securityTolerance = config.securityTolerance ?? 0.02;
  const moneyReadyRatio = config.moneyReadyRatio ?? 0.999;

  if (observation.security > observation.minSecurity + securityTolerance) {
    return PHASE.SECURITY_PREP_READY;
  }
  if (observation.money < observation.maxMoney * moneyReadyRatio) {
    return PHASE.MONEY_PREP_READY;
  }
  return PHASE.BATCH_READY;
}

export function isStillCommittable(input: {
  group: JobGroup;
  currentGeneration: number;
  fresh: Observation;
  config: SchedulerConfig;
}): { ok: true } | { ok: false; reason: string } {
  const { group, currentGeneration, fresh, config } = input;

  if (group.targetGeneration !== currentGeneration) {
    return {
      ok: false,
      reason:
        `target generation moved from ${group.targetGeneration} ` +
        `to ${currentGeneration}`,
    };
  }

  const actual = classifyObservation(fresh, config);
  const expected =
    group.purpose === "batch"
      ? PHASE.BATCH_READY
      : group.purpose === "money-prep"
        ? PHASE.MONEY_PREP_READY
        : PHASE.SECURITY_PREP_READY;

  if (actual !== expected) {
    return {
      ok: false,
      reason: `target state moved from ${expected} to ${actual}`,
    };
  }

  return { ok: true };
}

function isPrepPhase(record: TargetRecord): boolean {
  return (
    record.phase === PHASE.SECURITY_PREP_READY ||
    record.phase === PHASE.MONEY_PREP_READY
  );
}

/** Pure reducer. Returns a new record; never mutates the input. */
export function reduceTarget(
  record: TargetRecord,
  event: TargetEvent,
  config: SchedulerConfig,
): TargetRecord {
  switch (event.type) {
    case "observed": {
      if (!event.observation) return record;

      const phase = classifyObservation(event.observation, config);
      const enteringPrep =
        phase === PHASE.SECURITY_PREP_READY || phase === PHASE.MONEY_PREP_READY;

      return {
        ...record,
        phase,
        generation: record.generation + 1,
        observation: event.observation,
        economics: event.economics ?? null,
        activeGroupId: null,
        scheduledBatchCount: 0,
        dirtyReason: null,
        settleAfter: 0,
        waitingSince:
          enteringPrep && isPrepPhase(record) ? record.waitingSince : event.now,
      };
    }

    case "group-committed": {
      return {
        ...record,
        phase:
          event.purpose === "batch"
            ? PHASE.BATCH_IN_FLIGHT
            : PHASE.PREP_IN_FLIGHT,
        activeGroupId: event.groupId ?? null,
        batchTooLargeCount:
          event.purpose === "batch" ? 0 : record.batchTooLargeCount,
        batchSizeNotches:
          event.purpose === "batch" ? 0 : record.batchSizeNotches,
        scheduledBatchCount:
          event.purpose === "batch"
            ? record.scheduledBatchCount + Math.max(0, event.batchCount ?? 0)
            : record.scheduledBatchCount,
      };
    }

    case "receipts-terminal": {
      return {
        ...record,
        phase: PHASE.SETTLING,
        settleAfter: event.now + (config.settleBufferMs ?? 250),
      };
    }

    case "settled": {
      if (event.now < record.settleAfter) return record;
      return {
        ...record,
        phase: PHASE.NEEDS_OBSERVATION,
        activeGroupId: null,
      };
    }

    case "launch-failed":
    case "timing-fault": {
      return {
        ...record,
        phase: PHASE.BACKOFF,
        activeGroupId: null,
        dirtyReason: event.reason ?? event.type,
        backoffUntil: event.now + (config.backoffMs ?? 5_000),
      };
    }

    case "continuation-failed": {
      return {
        ...record,
        dirtyReason: event.reason ?? event.type,
      };
    }

    case "batch-too-large": {
      const count = record.batchTooLargeCount + 1;
      const nextNotches = Math.floor(count / 3);
      return {
        ...record,
        batchTooLargeCount: count,
        batchSizeNotches: nextNotches,
        phase:
          nextNotches > record.batchSizeNotches
            ? PHASE.NEEDS_OBSERVATION
            : record.phase,
      };
    }

    case "backoff-elapsed": {
      if (event.now < record.backoffUntil) return record;
      return { ...record, phase: PHASE.NEEDS_OBSERVATION };
    }

    default:
      return record;
  }
}

export function checkEligibility(
  record: TargetRecord,
  inFlight: InFlightLedger,
  config: SchedulerConfig,
  now: number,
): { eligible: boolean; reason?: ReasonCode } {
  if (record.activeGroupId !== null) {
    return { eligible: false, reason: IDLE_REASON.ALL_TARGETS_BUSY };
  }
  if (targetHasLiveReceipts(inFlight, record.host)) {
    return { eligible: false, reason: IDLE_REASON.ALL_TARGETS_BUSY };
  }
  if (
    record.phase === PHASE.PREP_IN_FLIGHT ||
    record.phase === PHASE.BATCH_IN_FLIGHT ||
    record.phase === PHASE.SETTLING
  ) {
    return { eligible: false, reason: IDLE_REASON.ALL_TARGETS_BUSY };
  }
  if (record.phase === PHASE.BACKOFF && now < record.backoffUntil) {
    return { eligible: false, reason: IDLE_REASON.LAUNCH_BACKOFF };
  }
  if (record.phase === PHASE.NEEDS_OBSERVATION || record.observation === null) {
    return { eligible: false, reason: IDLE_REASON.WAITING_FOR_OBSERVATION };
  }
  if (record.phase === PHASE.UNAVAILABLE) {
    return { eligible: false, reason: IDLE_REASON.NO_ELIGIBLE_TARGETS };
  }

  const ttl = config.observationTtlMs ?? 5_000;
  if (now - record.observation.observedAt > ttl) {
    return { eligible: false, reason: IDLE_REASON.STALE_SNAPSHOT };
  }

  return { eligible: true };
}

function compareBatchCandidates(a: TargetRecord, b: TargetRecord): number {
  const aRate = a.economics?.expectedMoneyPerSecond ?? 0;
  const bRate = b.economics?.expectedMoneyPerSecond ?? 0;
  return bRate - aRate || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
}

export function continuationWindow(
  record: TargetRecord,
  inFlight: InFlightLedger,
  config: SchedulerConfig,
): ContinuationWindow | null {
  const batch = record.economics?.preparedBatch;
  const groupId = record.activeGroupId;
  if (
    record.phase !== PHASE.BATCH_IN_FLIGHT ||
    !batch ||
    record.dirtyReason !== null ||
    groupId === null ||
    groupId === "recovered"
  ) {
    return null;
  }

  const fault = inFlight.groupFaults[groupId];
  if (
    (fault?.lost ?? 0) > 0 ||
    (fault?.late ?? 0) > 0 ||
    (fault?.killed ?? 0) > 0
  ) {
    return null;
  }

  const live = inFlight.receipts.filter(
    (receipt) =>
      receipt.groupId === groupId &&
      receipt.target === record.host &&
      isLiveStatus(receipt.status),
  );
  if (live.length === 0) return null;

  const lastEndAt = Math.max(...live.map((receipt) => receipt.expectedEndAt));
  return {
    lastEndAt,
    launchAt:
      lastEndAt + config.landingGap - config.launchLead - batch.weakenTime,
  };
}

/**
 * Aged prep candidates are promoted ahead of richer but newer ones so a large
 * low-value target cannot starve a smaller useful one. This never lets prep
 * outrank a batch, because prep is only reached in pass 2.
 */
function makePrepComparator(
  config: SchedulerConfig,
  now: number,
): (a: TargetRecord, b: TargetRecord) => number {
  const aging = config.prepAgingMs ?? 60_000;

  return (a, b) => {
    const aAged = now - a.waitingSince >= aging ? 1 : 0;
    const bAged = now - b.waitingSince >= aging ? 1 : 0;
    if (aAged !== bAged) return bAged - aAged;

    const aRate =
      a.economics?.prepPriority ?? a.economics?.expectedMoneyPerSecond ?? 0;
    const bRate =
      b.economics?.prepPriority ?? b.economics?.expectedMoneyPerSecond ?? 0;
    if (aRate !== bRate) return bRate - aRate;

    return (
      a.waitingSince - b.waitingSince ||
      (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)
    );
  };
}

export function decide(input: DecideInput): Decision {
  const { targets, snapshots, inFlight, workers, config, now, serial } = input;
  const tag = config.tagPrefix ?? "mm";

  if (input.conflictingManager) {
    return {
      kind: "idle",
      dominantReason: IDLE_REASON.CONFLICTING_MANAGER,
      reasons: [{ host: "-", code: IDLE_REASON.CONFLICTING_MANAGER }],
      idleUnits: 0,
    };
  }

  const ledger = createLedger(snapshots);
  const free = totalUnits(ledger);

  const reasons: IdleReason[] = [];

  // ---------------------------------------------------------------------------
  // Pass 1: complete profitable batches
  // ---------------------------------------------------------------------------

  const batchCandidates: BatchCandidate[] = [];

  for (const record of targets) {
    const continuation = continuationWindow(record, inFlight, config);
    if (continuation) {
      if (now >= continuation.launchAt) {
        batchCandidates.push({ record, continuation });
      } else {
        reasons.push({
          host: record.host,
          code: IDLE_REASON.ALL_TARGETS_BUSY,
          detail: `batch continuation opens at ${continuation.launchAt}`,
        });
      }
      continue;
    }

    const eligibility = checkEligibility(record, inFlight, config, now);
    if (!eligibility.eligible) {
      reasons.push({
        host: record.host,
        code: eligibility.reason ?? IDLE_REASON.NO_ELIGIBLE_TARGETS,
      });
      continue;
    }
    if (record.phase !== PHASE.BATCH_READY) continue;

    if (
      !record.economics?.preparedBatch ||
      (record.economics.expectedMoneyPerSecond ?? 0) <= 0
    ) {
      reasons.push({
        host: record.host,
        code: IDLE_REASON.NO_PROFITABLE_BATCH,
      });
      continue;
    }

    batchCandidates.push({ record, continuation: null });
  }

  batchCandidates.sort((a, b) => compareBatchCandidates(a.record, b.record));

  let pendingBatch: BatchWindowInput["pendingBatch"] = null;

  for (const candidate of batchCandidates) {
    const { record, continuation } = candidate;
    const batch = record.economics?.preparedBatch;
    if (!batch) continue;

    const result = planLargestWave({
      target: record.host,
      batch,
      workers,
      config,
      ledger,
      groupId:
        continuation && record.activeGroupId
          ? record.activeGroupId
          : `${tag}-b${serial}-${record.host}`,
      targetGeneration: record.generation,
      plannedAt: now,
      batchIndexStart: continuation ? record.scheduledBatchCount : 0,
      landingOffset: continuation
        ? Math.max(
            0,
            continuation.lastEndAt +
              config.landingGap -
              now -
              config.launchLead -
              batch.weakenTime,
          )
        : 0,
      continuation: continuation !== null,
    });

    if (result.ok) {
      return {
        kind: "batch",
        target: record.host,
        group: result.group,
        allocations: result.allocations,
        reasons,
      };
    }

    reasons.push(
      continuation
        ? {
            host: record.host,
            code: IDLE_REASON.RESERVED_FOR_BATCH_WINDOW,
            detail: `continuation waits for RAM: ${result.rejection.detail}`,
          }
        : {
            host: record.host,
            code: result.rejection.code,
            detail: result.rejection.detail,
          },
    );

    if (pendingBatch === null) {
      pendingBatch = {
        host: record.host,
        requiredUnits: result.rejection.requiredUnits,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 2: preparation from RAM the batch pass left idle
  // ---------------------------------------------------------------------------

  const prepCandidates: TargetRecord[] = [];

  for (const record of targets) {
    if (!isPrepPhase(record)) continue;
    const eligibility = checkEligibility(record, inFlight, config, now);
    if (!eligibility.eligible) continue;
    prepCandidates.push(record);
  }

  prepCandidates.sort(makePrepComparator(config, now));

  for (const record of prepCandidates) {
    const result = planPrep(
      record,
      workers,
      config,
      ledger,
      now,
      `${tag}-p${serial}-${record.host}`,
    );

    if (result === null) {
      reasons.push({
        host: record.host,
        code: IDLE_REASON.PREP_GROUP_TOO_LARGE,
        detail: "no prep spec",
      });
      continue;
    }

    if (!result.ok) {
      reasons.push({
        host: record.host,
        code: result.rejection.code,
        detail: result.rejection.detail,
      });
      continue;
    }

    const group = result.group;

    const guard = batchWindowGuard({
      prepGroup: group,
      prepUnits: requiredUnits(group.jobs),
      pendingBatch,
      inFlight,
      freeUnits: free,
    });

    if (!guard.allowed) {
      reasons.push({
        host: record.host,
        code: IDLE_REASON.RESERVED_FOR_BATCH_WINDOW,
        detail: guard.detail,
      });
      continue;
    }

    return {
      kind: "prep",
      target: record.host,
      group,
      allocations: result.allocations,
      reasons,
    };
  }

  return {
    kind: "idle",
    dominantReason: dominantReason(reasons, targets.length),
    reasons,
    idleUnits: free,
  };
}

/**
 * Prep shrinks to fit. Both planners keep the group complete — money prep is
 * always a grow/weaken pair — but a smaller pair is legitimate progress.
 *
 * Returns null when the target carries no usable prep spec at all.
 */
function planPrep(
  record: TargetRecord,
  workers: WorkerCosts,
  config: SchedulerConfig,
  ledger: Ledger,
  now: number,
  groupId: string,
): PrepPlanResult {
  const observation = record.observation;
  if (!observation) return null;

  const shared = {
    target: record.host,
    workers,
    config,
    ledger,
    groupId,
    targetGeneration: record.generation,
    plannedAt: now,
  };

  if (record.phase === PHASE.SECURITY_PREP_READY) {
    const securityPrep = record.economics?.securityPrep;
    if (!securityPrep || securityPrep.threadsNeeded < 1) return null;

    const moneyPrep = record.economics?.moneyPrep;
    if (
      observation.money <
        observation.maxMoney * (config.moneyReadyRatio ?? 0.999) &&
      moneyPrep &&
      moneyPrep.growThreadsNeeded > 0
    ) {
      const combined = planLargestMoneyPrep({
        ...shared,
        purpose: "security-prep",
        prep: {
          ...moneyPrep,
          baseWeakenThreads: securityPrep.threadsNeeded,
        },
      });
      if (combined.ok) return combined;
    }

    return planLargestSecurityPrep({ ...shared, prep: securityPrep });
  }

  const prep = record.economics?.moneyPrep;
  if (!prep || prep.growThreadsNeeded < 1) return null;
  return planLargestMoneyPrep({ ...shared, prep });
}

/**
 * Prep may not push out a batch window the scheduler can already see. This
 * applies only to observed BATCH_READY targets — never to a target that merely
 * might become ready.
 */
export function batchWindowGuard(input: BatchWindowInput): BatchWindowResult {
  const { prepGroup, prepUnits, pendingBatch, inFlight, freeUnits } = input;

  if (pendingBatch === null) return { allowed: true };

  const shortfall = pendingBatch.requiredUnits - freeUnits;
  if (shortfall <= 0) return { allowed: true };

  const windowStart = earliestReleaseTime(inFlight, shortfall);
  if (windowStart === null) return { allowed: true };

  // Prep that has given its RAM back before the window cannot delay anything.
  if (prepGroup.expectedLastEndAt <= windowStart) return { allowed: true };

  const unitsAtWindow =
    freeUnits + unitsReleasedBy(inFlight, windowStart) - prepUnits;
  if (unitsAtWindow >= pendingBatch.requiredUnits) return { allowed: true };

  return {
    allowed: false,
    detail: `prep would hold ${prepUnits} units past the ${pendingBatch.host} batch window at ${windowStart}`,
  };
}

function dominantReason(
  reasons: IdleReason[],
  targetCount: number,
): ReasonCode {
  if (targetCount === 0 || reasons.length === 0)
    return IDLE_REASON.NO_ELIGIBLE_TARGETS;

  const counts = new Map<ReasonCode, number>();
  for (const reason of reasons) {
    counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
  }

  let bestCode: ReasonCode = IDLE_REASON.NO_ELIGIBLE_TARGETS;
  let bestCount = -1;

  for (const [code, count] of counts) {
    if (count > bestCount || (count === bestCount && code < bestCode)) {
      bestCode = code;
      bestCount = count;
    }
  }

  return bestCode;
}
