/**
 * multi-manager.ts — multi-target H/W/G/W scheduler for Bitburner 3.0.2
 *
 * The loop is deliberately boring. All allocation maths lives in
 * multi-planning.ts, all policy in multi-scheduler.ts, and every Netscript call
 * in multi-runtime.ts.
 *
 *   refresh infrastructure -> reconcile receipts -> observe quiescent targets
 *   -> snapshot runners -> ask for one decision -> commit it -> render -> sleep
 *
 * manager.ts remains the single-target fallback and is never modified or killed
 * by this script.
 *
 * Start:
 *   run multi-manager.ts --hack 0.10 --reserve 8 --targets 8
 *
 * Plan without launching anything:
 *   run multi-manager.ts --dry
 *   run multi-manager.ts --report
 */

import { clamp, formatRam, loadWorkers, rankTargets } from "./hacking-lib.ts";

import {
  DEFAULT_CONFIG,
  IDLE_REASON,
  RECEIPT_STATUS,
  createInFlightLedger,
  createLedger,
  clearGroupFault,
  fromUnits,
  isLiveStatus,
  pruneTerminalReceipts,
  publishGroup,
  requiredUnits,
  snapshotRunners,
  targetHasLiveReceipts,
  totalUnits,
} from "./multi-planning.ts";

import {
  PHASE,
  canRefill,
  continuationWindow,
  createTargetRecord,
  decide,
  reduceTarget,
} from "./multi-scheduler.ts";

import {
  commitGroup,
  computeEconomics,
  detectConflictingManager,
  isMoneyTarget,
  observeTarget,
  pollReceipts,
  pruneDeadRecovered,
  readRunners,
  recoverTaggedProcesses,
  refreshInfrastructure,
} from "./multi-runtime.ts";

import type {
  Fragment,
  InFlightLedger,
  RunnerSnapshot,
  SchedulerConfig,
  WorkerCosts,
} from "./multi-planning.ts";

import type { Decision, TargetEvent, TargetRecord } from "./multi-scheduler.ts";

import type { RecoveredWorker } from "./multi-runtime.ts";

type ManagerConfig = SchedulerConfig & {
  help: boolean;
  report: boolean;
  dryRun: boolean;
  maxTargets: number;
  infrastructureMs: number;
  observationTtlMs: number;
  pollCapMs: number;
  pollFloorMs: number;
  hackFraction: number;
  minimumHackFraction: number;
  launchSafetyMs: number;
  refillCommitCap: number;
  refillBudgetMs: number;
};

type ManagerState = {
  hosts: string[];
  deployedHosts: Set<string>;
  targets: Map<string, TargetRecord>;
  inFlight: InFlightLedger;
  recovered: RecoveredWorker[];
  nextInfrastructureRefresh: number;
  serial: number;
  loops: number;
  startedAt: number;
  launched: number;
  launchFailures: number;
  wouldLaunch: number;
  lastCommit: string;
  rooted: number;
  deployed: number;
  sizingCapacityRam: number;
  workersAvailableHosts: Set<string>;
  nextFullReceiptSweep: number;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const config = readConfig(ns);
  if (config.help) return printHelp(ns);

  const workers = loadWorkers(ns);
  if (!workers) return;

  const conflict = detectConflictingManager(ns);
  if (conflict) return refuseToStart(ns, conflict);

  const state = createState();
  refreshNetwork(ns, state, config, workers);
  adoptRecoveredWork(ns, state, config);

  if (config.report) return printReport(ns, state, config, workers);

  while (true) {
    let now = Date.now();

    if (now >= state.nextInfrastructureRefresh)
      refreshNetwork(ns, state, config, workers);

    reconcileReceipts(ns, state, config, now);
    reconcileTargets(state, config, now);

    let snapshots = snapshotRunners(
      readRunners(ns, state.hosts, state.workersAvailableHosts),
      config,
    );
    observeTargets(ns, state, config, workers, now);

    const refillStartedAt = Date.now();
    let commits = 0;
    let decision: Decision;

    while (true) {
      now = Date.now();
      decision = decide({
        targets: [...state.targets.values()],
        snapshots,
        inFlight: state.inFlight,
        workers,
        config,
        now,
        serial: state.serial,
      });

      recordBatchSizingRejections(state, decision, config, now);
      const committed = commitDecision(ns, state, decision, config, now);
      if (!committed) break;

      commits++;
      snapshots = snapshotRunners(
        readRunners(ns, state.hosts, state.workersAvailableHosts),
        config,
      );
      if (
        !canRefill({
          commits,
          elapsedMs: Date.now() - refillStartedAt,
          commitCap: config.refillCommitCap,
          wallClockBudgetMs: config.refillBudgetMs,
        })
      ) {
        break;
      }
    }

    renderStatus(ns, state, config, snapshots, decision);

    await ns.sleep(nextWakeDelay(state, config, Date.now()));
  }
}

// -----------------------------------------------------------------------------
// Loop phases
// -----------------------------------------------------------------------------

function createState(): ManagerState {
  return {
    hosts: ["home"],
    deployedHosts: new Set(),
    targets: new Map(),
    inFlight: createInFlightLedger(),
    recovered: [],
    nextInfrastructureRefresh: 0,
    serial: 0,
    loops: 0,
    startedAt: Date.now(),
    launched: 0,
    launchFailures: 0,
    wouldLaunch: 0,
    lastCommit: "none yet",
    rooted: 0,
    deployed: 0,
    sizingCapacityRam: 0,
    workersAvailableHosts: new Set(["home"]),
    nextFullReceiptSweep: 0,
  };
}

function refreshNetwork(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  workers: WorkerCosts,
): void {
  const result = refreshInfrastructure(
    ns,
    state.deployedHosts,
    config.homeReserve,
  );
  state.hosts = result.hosts;
  state.rooted = result.rooted;
  state.deployed = result.deployed;
  state.sizingCapacityRam = result.sizingCapacityRam;
  state.workersAvailableHosts = result.workersAvailableHosts;
  state.nextInfrastructureRefresh = Date.now() + config.infrastructureMs;
  syncTrackedTargets(ns, state, config, workers);
}

/**
 * Track the top money servers, and never drop a target that still owns work in
 * flight.
 */
function syncTrackedTargets(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  workers: WorkerCosts,
): void {
  const ranked = rankTargets(
    ns,
    state.hosts,
    workers,
    config,
    state.sizingCapacityRam,
  );
  const rankedHosts = new Set(ranked.map((row) => row.host));
  const maxSecurityFallbacks = state.hosts
    .filter(
      (host) =>
        !rankedHosts.has(host) &&
        isMoneyTarget(ns, host) &&
        ns.getServerSecurityLevel(host) >= 100,
    )
    .map((host) => ({
      host,
      score:
        ns.getServerMaxMoney(host) /
        Math.max(0.001, ns.getWeakenTime(host) / 1_000),
    }));
  const candidates = [
    ...ranked.map((row) => ({ host: row.host, score: row.score })),
    ...maxSecurityFallbacks,
  ]
    .sort((a, b) => b.score - a.score || a.host.localeCompare(b.host))
    .slice(0, config.maxTargets)
    .map((row) => row.host);

  for (const host of candidates) {
    if (!state.targets.has(host))
      state.targets.set(host, createTargetRecord(host));
  }

  const keep = new Set(candidates);
  for (const [host, record] of state.targets) {
    const busy =
      record.activeGroupId !== null ||
      targetHasLiveReceipts(state.inFlight, host);
    if (!keep.has(host) && !busy) state.targets.delete(host);
  }
}

/**
 * Workers tagged by a previous instance keep their target locked until they
 * stop. Their effects are never assumed; the target is re-observed afterwards.
 */
function adoptRecoveredWork(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
): void {
  state.recovered = recoverTaggedProcesses(ns, state.hosts, config);

  for (const entry of state.recovered) {
    if (!entry.target) continue;
    if (!state.targets.has(entry.target)) {
      state.targets.set(entry.target, createTargetRecord(entry.target));
    }
    const record = state.targets.get(entry.target);
    if (record) {
      state.targets.set(entry.target, {
        ...record,
        activeGroupId: "recovered",
      });
    }
  }
}

function reconcileReceipts(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  now: number,
): void {
  const fullSweep = now >= state.nextFullReceiptSweep;
  const result = pollReceipts(ns, state.inFlight, config, now, fullSweep);
  state.inFlight = result.ledger;
  if (fullSweep) state.nextFullReceiptSweep = now + 2_000;

  if (state.recovered.length === 0) return;

  const alive = pruneDeadRecovered(ns, state.recovered);
  const finished = state.recovered.filter(
    (entry) => !alive.some((live) => live.pid === entry.pid),
  );
  state.recovered = alive;

  for (const entry of finished) {
    const stillBusy = alive.some((live) => live.target === entry.target);
    const record = state.targets.get(entry.target);
    if (record && !stillBusy && record.activeGroupId === "recovered") {
      state.targets.set(entry.target, {
        ...record,
        activeGroupId: null,
        phase: PHASE.NEEDS_OBSERVATION,
      });
    }
  }
}

/**
 * Advance settling and backoff, and close out groups whose fragments have all
 * stopped. Every closed group leads back to NEEDS_OBSERVATION.
 */
function reconcileTargets(
  state: ManagerState,
  config: ManagerConfig,
  now: number,
): void {
  for (const [host, record] of state.targets) {
    if (record.phase === PHASE.SETTLING) {
      state.targets.set(
        host,
        reduceTarget(record, { type: "settled", now }, config),
      );
      continue;
    }

    if (record.phase === PHASE.BACKOFF) {
      state.targets.set(
        host,
        reduceTarget(record, { type: "backoff-elapsed", now }, config),
      );
      continue;
    }

    if (record.activeGroupId === null || record.activeGroupId === "recovered")
      continue;

    const owned = state.inFlight.receipts.filter(
      (receipt) => receipt.groupId === record.activeGroupId,
    );
    if (owned.length === 0) continue;
    if (owned.some((receipt) => isLiveStatus(receipt.status))) continue;

    const fault = state.inFlight.groupFaults[record.activeGroupId];
    const terminalFaults = (fault?.lost ?? 0) + (fault?.killed ?? 0);
    const event: TargetEvent =
      terminalFaults > 0 || record.dirtyReason
        ? {
            type: "timing-fault",
            reason: record.dirtyReason
              ? record.dirtyReason
              : `${fault?.lost ?? 0} fragment(s) lost, ${
                  fault?.killed ?? 0
                } killed`,
            now,
          }
        : { type: "receipts-terminal", now };

    state.targets.set(host, reduceTarget(record, event, config));
    state.inFlight = clearGroupFault(state.inFlight, record.activeGroupId);
  }

  state.inFlight = pruneTerminalReceipts(state.inFlight);
}

/**
 * Observe only quiescent targets, and only when their data is missing or stale.
 * A target with any live receipt is never observed.
 */
function observeTargets(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  workers: WorkerCosts,
  now: number,
): void {
  for (const [host, record] of state.targets) {
    if (record.activeGroupId !== null) continue;
    if (targetHasLiveReceipts(state.inFlight, host)) continue;
    if (record.phase === PHASE.SETTLING || record.phase === PHASE.BACKOFF)
      continue;

    const missing = record.observation === null;
    const stale =
      record.observation !== null &&
      now - record.observation.observedAt > config.observationTtlMs;

    if (!missing && !stale && record.phase !== PHASE.NEEDS_OBSERVATION)
      continue;

    const observation = observeTarget(ns, host, now);
    const targetConfig = {
      ...config,
      hackFraction: Math.max(
        config.minimumHackFraction,
        config.hackFraction * Math.pow(0.8, record.batchSizeNotches),
      ),
    };
    const economics = observation.valid
      ? computeEconomics(
          ns,
          observation,
          host,
          workers,
          targetConfig,
          state.sizingCapacityRam,
        )
      : null;

    state.targets.set(
      host,
      reduceTarget(
        record,
        { type: "observed", observation, economics, now },
        config,
      ),
    );
  }
}

function recordBatchSizingRejections(
  state: ManagerState,
  decision: Decision,
  config: ManagerConfig,
  now: number,
): void {
  const rejected = new Set(
    decision.reasons
      .filter((reason) => reason.code === IDLE_REASON.COMPLETE_BATCH_TOO_LARGE)
      .map((reason) => reason.host),
  );

  for (const host of rejected) {
    const record = state.targets.get(host);
    if (!record || record.activeGroupId !== null) continue;
    state.targets.set(
      host,
      reduceTarget(record, { type: "batch-too-large", now }, config),
    );
  }
}

function commitDecision(
  ns: NS,
  state: ManagerState,
  decision: Decision,
  config: ManagerConfig,
  now: number,
): boolean {
  if (decision.kind === "idle") return false;

  const { group, allocations } = decision;

  if (config.dryRun) {
    state.wouldLaunch++;
    state.lastCommit =
      `DRY RUN would launch ${describeDecision(decision)} ` +
      `(${allocations.length} fragments)`;
    return false;
  }

  const record = state.targets.get(decision.target);
  if (!record) return false;

  const result = commitGroup(ns, group, allocations, config, record.generation);

  if (!result.ok) {
    state.launchFailures++;
    state.lastCommit = `FAILED ${decision.target}: ${result.reason}`;
    state.targets.set(
      decision.target,
      reduceTarget(
        record,
        {
          type: group.continuation ? "continuation-failed" : "launch-failed",
          reason: result.reason,
          now,
        },
        config,
      ),
    );
    return false;
  }

  state.inFlight = publishGroup(
    state.inFlight,
    group,
    result.allocations,
    result.pids,
    result.plannedAt,
  );

  state.targets.set(
    decision.target,
    reduceTarget(
      record,
      {
        type: "group-committed",
        groupId: group.id,
        purpose: group.purpose === "batch" ? "batch" : "prep",
        batchCount: group.batchCount,
        now,
      },
      config,
    ),
  );

  state.serial++;
  state.launched++;
  state.lastCommit = `${describeDecision(decision)} on ${result.pids.length} pid(s)`;
  return true;
}

/**
 * Wake at the earliest useful event, capped so manual interference stays
 * visible without making the loop busy.
 */
function nextWakeDelay(
  state: ManagerState,
  config: ManagerConfig,
  now: number,
): number {
  let earliest = now + config.pollCapMs;

  for (const receipt of state.inFlight.receipts) {
    if (isLiveStatus(receipt.status)) {
      earliest = Math.min(earliest, receipt.expectedEndAt);
    }
  }
  for (const record of state.targets.values()) {
    if (record.phase === PHASE.SETTLING)
      earliest = Math.min(earliest, record.settleAfter);
    if (record.phase === PHASE.BACKOFF)
      earliest = Math.min(earliest, record.backoffUntil);
    const continuation = continuationWindow(record, state.inFlight, config);
    if (continuation && continuation.launchAt > now) {
      earliest = Math.min(earliest, continuation.launchAt);
    }
  }
  earliest = Math.min(earliest, state.nextInfrastructureRefresh);

  return Math.max(
    config.pollFloorMs,
    Math.min(config.pollCapMs, earliest - now),
  );
}

// -----------------------------------------------------------------------------
// Display
// -----------------------------------------------------------------------------

function describeDecision(decision: Decision): string {
  if (decision.kind === "idle") return "idle";

  const { group } = decision;

  const size =
    group.purpose === "batch" ? `${group.batchCount}x batch` : group.purpose;
  return `${size} on ${group.target} (${formatRam(fromUnits(requiredUnits(group.jobs)))})`;
}

function renderStatus(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  snapshots: RunnerSnapshot[],
  decision: Decision,
): void {
  state.loops++;
  ns.clearLog();

  const usable = state.sizingCapacityRam;
  const free = fromUnits(totalUnits(createLedger(snapshots)));
  const inFlightRam = fromUnits(
    state.inFlight.receipts.reduce(
      (sum, receipt) =>
        sum + (isLiveStatus(receipt.status) ? receipt.units : 0),
      0,
    ),
  );

  ns.print(
    `=== MULTI-TARGET SCHEDULER ${config.dryRun ? "(DRY RUN)" : ""} ===`,
  );
  ns.print(
    `Loop ${state.loops} | up ${formatDuration(Date.now() - state.startedAt)} | ` +
      `launched ${state.launched} | failed ${state.launchFailures}` +
      (config.dryRun ? ` | would launch ${state.wouldLaunch}` : ""),
  );
  ns.print(
    `Network: ${state.hosts.length} known | ${snapshots.length} runners | ` +
      `rooted +${state.rooted} | deployed +${state.deployed}`,
  );
  ns.print(
    `RAM: ${formatRam(usable)} usable | ${formatRam(free)} schedulable | ` +
      `${formatRam(inFlightRam)} in flight | ${formatRam(config.homeReserve)} home reserve`,
  );
  ns.print(`Last commit: ${state.lastCommit}`);

  renderTargets(ns, state);
  renderInFlight(ns, state);
  renderDecision(ns, decision, free);
}

function renderTargets(ns: NS, state: ManagerState): void {
  ns.print(`--- targets (${state.targets.size}) ---`);

  for (const record of rankedRecords(state)) {
    const observation = record.observation;
    const money =
      observation && observation.maxMoney > 0
        ? `${((observation.money / observation.maxMoney) * 100).toFixed(0)}%`
        : "-";
    const security = observation
      ? `${observation.security.toFixed(1)}/${observation.minSecurity.toFixed(1)}`
      : "-";
    const rate = record.economics?.expectedMoneyPerSecond ?? 0;

    ns.print(
      `  ${record.host.padEnd(18)} ${record.phase.padEnd(19)} ` +
        `gen ${String(record.generation).padStart(3)} | ` +
        `money ${money.padStart(4)} | sec ${security.padStart(11)} | ` +
        `$${ns.format.number(rate)}/s`,
    );
  }
}

function renderInFlight(ns: NS, state: ManagerState): void {
  const live = state.inFlight.receipts.filter((receipt) =>
    isLiveStatus(receipt.status),
  );

  if (live.length === 0 && state.recovered.length === 0) {
    ns.print("--- in flight: none ---");
    return;
  }

  const groups = new Map<
    string,
    {
      fragments: number;
      units: number;
      endsAt: number;
      target: string;
      late: number;
      lost: number;
      killed: number;
    }
  >();

  for (const receipt of live) {
    const entry = groups.get(receipt.groupId) ?? {
      fragments: 0,
      units: 0,
      endsAt: 0,
      target: receipt.target,
      late: 0,
      lost: 0,
      killed: 0,
    };
    entry.fragments++;
    entry.units += receipt.units;
    entry.endsAt = Math.max(entry.endsAt, receipt.expectedEndAt);
    const fault = state.inFlight.groupFaults[receipt.groupId];
    entry.late =
      fault?.late ?? (receipt.status === RECEIPT_STATUS.LATE ? 1 : 0);
    entry.lost = fault?.lost ?? 0;
    entry.killed = fault?.killed ?? 0;
    groups.set(receipt.groupId, entry);
  }

  ns.print(
    `--- in flight: ${groups.size} group(s), ${live.length} fragment(s) ---`,
  );

  const now = Date.now();
  for (const [id, entry] of groups) {
    ns.print(
      `  ${id.padEnd(26)} ${entry.target.padEnd(16)} ` +
        `${String(entry.fragments).padStart(3)} frag | ` +
        `${formatRam(fromUnits(entry.units)).padStart(10)} | ` +
        `ends in ${formatDuration(Math.max(0, entry.endsAt - now))}` +
        (entry.late > 0 ? ` | ${entry.late} LATE` : "") +
        (entry.lost > 0 ? ` | ${entry.lost} LOST` : "") +
        (entry.killed > 0 ? ` | ${entry.killed} KILLED` : ""),
    );
  }

  if (state.recovered.length > 0) {
    ns.print(
      `  recovered from a previous run: ${state.recovered.length} worker(s)`,
    );
  }
}

function renderDecision(ns: NS, decision: Decision, freeRam: number): void {
  if (decision.kind !== "idle") {
    ns.print(`--- decision: ${describeDecision(decision)} ---`);
    for (const line of groupFragments(decision.allocations))
      ns.print(`  ${line}`);
    return;
  }

  ns.print(
    `--- idle: ${formatRam(freeRam)} unallocated (${decision.dominantReason}) ---`,
  );

  const byCode = new Map<string, string[]>();
  for (const reason of decision.reasons) {
    byCode.set(reason.code, [...(byCode.get(reason.code) ?? []), reason.host]);
  }

  for (const [code, hosts] of byCode) {
    const shown = hosts.slice(0, 4).join(", ");
    const extra = hosts.length > 4 ? ` +${hosts.length - 4} more` : "";
    ns.print(`  ${code.padEnd(26)} ${shown}${extra}`);
  }
}

/** One line per runner used by a committed allocation. */
function groupFragments(allocations: Fragment[]): string[] {
  const byHost = new Map<string, { threads: number; units: number }>();

  for (const fragment of allocations) {
    const entry = byHost.get(fragment.host) ?? { threads: 0, units: 0 };
    entry.threads += fragment.threads;
    entry.units += fragment.units;
    byHost.set(fragment.host, entry);
  }

  return [...byHost.entries()].map(
    ([host, entry]) =>
      `${host.padEnd(20)} ${String(entry.threads).padStart(5)} threads | ` +
      formatRam(fromUnits(entry.units)),
  );
}

function rankedRecords(state: ManagerState): TargetRecord[] {
  return [...state.targets.values()].sort(
    (a, b) =>
      (b.economics?.expectedMoneyPerSecond ?? 0) -
      (a.economics?.expectedMoneyPerSecond ?? 0),
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

// -----------------------------------------------------------------------------
// Report mode
// -----------------------------------------------------------------------------

function refuseToStart(ns: NS, conflict: string): void {
  ns.tprint(`ERROR: ${IDLE_REASON.CONFLICTING_MANAGER} — ${conflict}`);
  ns.tprint(
    "Stop the other manager first. This script will not kill it for you.",
  );
}

/**
 * One observation pass, one decision, no exec.
 */
function printReport(
  ns: NS,
  state: ManagerState,
  config: ManagerConfig,
  workers: WorkerCosts,
): void {
  const now = Date.now();
  const snapshots = snapshotRunners(
    readRunners(ns, state.hosts, state.workersAvailableHosts),
    config,
  );
  const usable = state.sizingCapacityRam;

  for (const [host, record] of state.targets) {
    const observation = observeTarget(ns, host, now);
    const economics = observation.valid
      ? computeEconomics(ns, observation, host, workers, config, usable)
      : null;
    state.targets.set(
      host,
      reduceTarget(
        record,
        { type: "observed", observation, economics, now },
        config,
      ),
    );
  }

  const decision = decide({
    targets: [...state.targets.values()],
    snapshots,
    inFlight: state.inFlight,
    workers,
    config,
    now,
    serial: 0,
  });

  ns.tprint(
    `\n=== multi-manager report | ${formatRam(usable)} usable | ` +
      `${snapshots.length} runners | hack <= ${ns.format.percent(config.hackFraction)} ===`,
  );
  ns.tprint(
    "host                 phase                money  sec           expected/s",
  );

  for (const record of rankedRecords(state)) {
    const observation = record.observation;
    const money =
      observation && observation.maxMoney > 0
        ? `${((observation.money / observation.maxMoney) * 100).toFixed(0)}%`
        : "-";
    const security = observation
      ? `${observation.security.toFixed(1)}/${observation.minSecurity.toFixed(1)}`
      : "-";

    ns.tprint(
      `${record.host.padEnd(20)} ${record.phase.padEnd(20)} ${money.padStart(5)}  ` +
        `${security.padEnd(13)} $${ns.format.number(record.economics?.expectedMoneyPerSecond ?? 0)}/s`,
    );
  }

  ns.tprint(`\nNext decision: ${describeDecision(decision)}`);

  if (decision.kind === "idle") {
    ns.tprint(`Idle reason: ${decision.dominantReason}`);
    for (const reason of decision.reasons.slice(0, 10)) {
      ns.tprint(
        `  ${reason.host.padEnd(20)} ${reason.code}` +
          (reason.detail ? ` — ${reason.detail}` : ""),
      );
    }
  } else {
    for (const line of groupFragments(decision.allocations))
      ns.tprint(`  ${line}`);
  }

  ns.tprint(
    "\nNothing was launched. Remove --report to run, or use --dry to watch it plan.",
  );
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

function readConfig(ns: NS): ManagerConfig {
  const flags = ns.flags([
    ["targets", 8],
    ["hack", 0.1],
    ["reserve", 8],
    ["gap", 200],
    ["batches", 20],
    ["lead", 1_000],
    ["infra", 15],
    ["ttl", 5],
    ["dry", false],
    ["report", false],
    ["help", false],
  ]);

  return {
    ...DEFAULT_CONFIG,
    help: Boolean(flags.help),
    report: Boolean(flags.report),
    dryRun: Boolean(flags.dry),
    maxTargets: Math.max(1, Math.floor(Number(flags.targets) || 8)),
    hackFraction: clamp(Number(flags.hack), 0.0025, 0.5),
    minimumHackFraction: 0.0025,
    homeReserve: Math.max(0, Number(flags.reserve) || 0),
    landingGap: Math.max(100, Math.floor(Number(flags.gap) || 200)),
    maxBatches: Math.max(1, Math.floor(Number(flags.batches) || 20)),
    launchLead: Math.max(250, Math.floor(Number(flags.lead) || 1_000)),
    launchSafetyMs: 250,
    refillCommitCap: 4,
    refillBudgetMs: 500,
    infrastructureMs: Math.max(5, Number(flags.infra) || 15) * 1_000,
    observationTtlMs: Math.max(1, Number(flags.ttl) || 5) * 1_000,
    pollCapMs: 1_000,
    pollFloorMs: 200,
  };
}

function printHelp(ns: NS): void {
  ns.tprint(`
multi-manager.ts — multi-target H/W/G/W scheduler

Start:
  run multi-manager.ts --hack 0.10 --reserve 8 --targets 8

Plan without launching:
  run multi-manager.ts --report      one-shot report, then exit
  run multi-manager.ts --dry         full loop, logs decisions, launches nothing

Options:
  --targets   targets tracked at once   default: 8
  --hack      maximum stolen/batch      default: 0.10
  --reserve   RAM kept free on home     default: 8
  --gap       landing gap in ms         default: 200
  --batches   maximum batches/wave      default: 20
  --lead      launch safety lead ms     default: 1000
  --infra     network refresh seconds   default: 15
  --ttl       observation lifetime s    default: 5
  --dry       plan and log, never exec
  --report    print a report and exit
  --help      show this text

manager.ts stays the single-target fallback. This script refuses to start while
manager.ts is running, and never kills it.
`);
}
