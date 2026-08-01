/**
 * multi-runtime.ts — every Netscript read, exec, kill and PID poll for the
 * multi-target scheduler.
 *
 * multi-planning.ts and multi-scheduler.ts are pure; this file is the only
 * place that talks to the game. Keeping the boundary here is what makes the
 * planning logic testable under `node --test`.
 */

import {
  WORKER_FILES,
  applyGrowSafetyMargin,
  buildPreparedBatch,
  deployWorkers,
  inspectTarget,
  rootAvailableServers,
  scanNetwork,
} from "./hacking-lib.ts";

import {
  applyReceiptStatus,
  classifyReceipt,
  isLiveStatus,
  stableSizingCapacity,
} from "./multi-planning.ts";
import { isStillCommittable, preparedPrepPriority } from "./multi-scheduler.ts";

import type {
  Fragment,
  InFlightLedger,
  JobGroup,
  ReceiptStatus,
  RunnerInput,
  SchedulerConfig,
  WorkerCosts,
} from "./multi-planning.ts";
import type { Observation, TargetEconomics } from "./multi-scheduler.ts";

type InspectedTarget =
  | { host: string; valid: false; reason: string }
  | {
      host: string;
      valid: true;
      money: number;
      maxMoney: number;
      security: number;
      minSecurity: number;
      requiredLevel: number;
      hackTime: number;
      growTime: number;
      weakenTime: number;
    };

export type RecoveredWorker = {
  host: string;
  pid: number;
  target: string;
  label: string;
};

export type InfrastructureRefresh = {
  hosts: string[];
  rooted: number;
  deployed: number;
  sizingCapacityRam: number;
  workersAvailableHosts: Set<string>;
};

export type CommitResult =
  | {
      ok: true;
      pids: number[];
      plannedAt: number;
      allocations: Fragment[];
    }
  | { ok: false; reason: string; rolledBack?: number };

export type ReceiptChange = { receiptId: string; status: ReceiptStatus };
export type PollResult = {
  ledger: InFlightLedger;
  changed: ReceiptChange[];
};

/**
 * Refuse to run alongside the single-target fallback or a second copy of
 * ourselves. Never kills either one.
 *
 * @param {NS} ns
 * @returns {string|null}
 */
export function detectConflictingManager(ns: NS): string | null {
  const self = ns.getScriptName();

  for (const process of ns.ps("home")) {
    if (process.filename === "manager.ts") {
      return `manager.ts is running on home (pid ${process.pid})`;
    }
    if (process.filename === self && process.pid !== ns.pid) {
      return `${self} is already running (pid ${process.pid})`;
    }
  }

  return null;
}

/**
 * @typedef {object} RecoveredWorker
 * @property {string} host
 * @property {number} pid
 * @property {string} target
 * @property {string} label
 */

/**
 * @param {NS} ns
 * @param {Set<string>} deployedHosts
 * @returns {{hosts: string[], rooted: number, deployed: number}}
 */
export function refreshInfrastructure(
  ns: NS,
  deployedHosts: Set<string>,
  homeReserve = 0,
): InfrastructureRefresh {
  const hosts = scanNetwork(ns);
  const rooted = rootAvailableServers(ns, hosts);
  const deployed = deployWorkers(ns, hosts, deployedHosts);
  const workerFiles: string[] = Object.values(WORKER_FILES);
  const capacityInputs = hosts
    .filter((host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0)
    .map((host) => {
      const workersAvailable =
        host === "home" ||
        workerFiles.every((file) => ns.fileExists(file, host));
      const foreignUsedRam = ns
        .ps(host)
        .filter((process) => !workerFiles.includes(process.filename))
        .reduce(
          (sum, process) =>
            sum + process.threads * ns.getScriptRam(process.filename, host),
          0,
        );
      return {
        host,
        maxRam: ns.getServerMaxRam(host),
        foreignUsedRam,
        workersAvailable,
      };
    });
  const workersAvailableHosts = new Set(
    capacityInputs
      .filter((runner) => runner.workersAvailable)
      .map((runner) => runner.host),
  );

  return {
    hosts,
    rooted,
    deployed,
    sizingCapacityRam: stableSizingCapacity(capacityInputs, homeReserve),
    workersAvailableHosts,
  };
}

/**
 * Raw runner facts. The home reserve is applied later, by the pure snapshot.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @returns {import("./multi-planning.ts").RunnerInput[]}
 */
export function readRunners(
  ns: NS,
  hosts: string[],
  workersAvailableHosts?: ReadonlySet<string>,
): RunnerInput[] {
  const files = Object.values(WORKER_FILES);

  return hosts
    .filter((host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0)
    .map((host) => ({
      host,
      maxRam: ns.getServerMaxRam(host),
      usedRam: ns.getServerUsedRam(host),
      workersAvailable:
        workersAvailableHosts?.has(host) ??
        (host === "home" || files.every((file) => ns.fileExists(file, host))),
    }));
}

/**
 * @param {NS} ns
 * @param {string} host
 * @returns {boolean}
 */
export function isMoneyTarget(ns: NS, host: string): boolean {
  if (!ns.serverExists(host) || !ns.hasRootAccess(host)) return false;
  const server = ns.getServer(host);
  if (server.purchasedByPlayer || (server.moneyMax ?? 0) <= 0) return false;
  return (server.requiredHackingSkill ?? Infinity) <= ns.getHackingLevel();
}

/**
 * A timestamped snapshot of a quiescent target.
 *
 * @param {NS} ns
 * @param {string} host
 * @param {number} now
 * @returns {Observation}
 */
export function observeTarget(ns: NS, host: string, now: number): Observation {
  const info = inspectTarget(ns, host) as InspectedTarget;

  if (!info.valid) {
    return {
      valid: false,
      observedAt: now,
      money: 0,
      maxMoney: 0,
      security: 0,
      minSecurity: 0,
      hackTime: 0,
      growTime: 0,
      weakenTime: 0,
      reason: info.reason,
    };
  }

  return {
    valid: true,
    observedAt: now,
    money: Number(info.money ?? 0),
    maxMoney: Number(info.maxMoney ?? 0),
    security: Number(info.security ?? 0),
    minSecurity: Number(info.minSecurity ?? 0),
    hackTime: Number(info.hackTime ?? 0),
    growTime: Number(info.growTime ?? 0),
    weakenTime: Number(info.weakenTime ?? 0),
  };
}

/**
 * Turn one observation into the plain numbers the pure planner needs. This is
 * a planning model, never asserted target state.
 *
 * @param {NS} ns
 * @param {Observation} observation
 * @param {string} host
 * @param {WorkerCosts} workers
 * @param {SchedulerConfig} config
 * @param {number} availableRam
 * @returns {TargetEconomics}
 */
export function computeEconomics(
  ns: NS,
  observation: Observation,
  host: string,
  workers: WorkerCosts,
  config: SchedulerConfig,
  availableRam: number,
): TargetEconomics {
  const preparedBatch = buildPreparedBatch(
    ns,
    host,
    workers,
    {
      ...config,
      hackFraction: config.hackFraction ?? 0,
      minimumHackFraction: config.minimumHackFraction ?? 0,
    },
    availableRam,
  );

  let expectedMoneyPerSecond = 0;
  if (preparedBatch) {
    const batches = Math.max(
      1,
      Math.min(
        config.maxBatches,
        Math.floor(availableRam / preparedBatch.ramNeeded),
      ),
    );
    const waveMs =
      config.launchLead +
      preparedBatch.weakenTime +
      (batches - 1) * 4 * config.landingGap +
      3 * config.landingGap;
    expectedMoneyPerSecond =
      (preparedBatch.expectedMoney * batches) / Math.max(0.001, waveMs / 1_000);
  }

  const weakenPerThread = ns.weakenAnalyze(1, 1);

  // No hostname on growthAnalyzeSecurity: passing one caps the answer against
  // the target's current money, which is wrong for growth planned after a hack.
  const growSecurityPerThread = ns.growthAnalyzeSecurity(1, undefined, 1);

  const multiplier = observation.maxMoney / Math.max(1, observation.money);
  let growThreadsNeeded = applyGrowSafetyMargin(
    ns.growthAnalyze(host, multiplier, 1),
    config.growSafetyMargin ?? 0,
  );
  if (!Number.isFinite(growThreadsNeeded) || growThreadsNeeded < 1) {
    growThreadsNeeded = 1;
  }

  const threadsNeeded = Math.max(
    1,
    Math.ceil(
      (observation.security - observation.minSecurity) / weakenPerThread,
    ),
  );

  return {
    preparedBatch,
    expectedMoneyPerSecond,
    prepPriority: preparedPrepPriority(
      expectedMoneyPerSecond,
      observation.maxMoney,
      observation.weakenTime,
    ),
    moneyPrep: {
      growThreadsNeeded,
      growSecurityPerThread,
      weakenPerThread,
      growTime: observation.growTime,
      weakenTime: observation.weakenTime,
    },
    securityPrep: { threadsNeeded, weakenTime: observation.weakenTime },
  };
}

/**
 * Commit one whole group, or launch nothing.
 *
 * Revalidates the launch deadline and every runner's free RAM before the first
 * exec, then rolls back every PID already started if any exec fails.
 *
 * @param {NS} ns
 * @param {JobGroup} group
 * @param {Fragment[]} allocations
 * @param {SchedulerConfig} config
 * @returns {{ok: true, pids: number[], plannedAt: number, allocations: Fragment[]}|{ok: false, reason: string, rolledBack?: number}}
 */
export function commitGroup(
  ns: NS,
  group: JobGroup,
  allocations: Fragment[],
  config: SchedulerConfig,
  currentGeneration: number,
): CommitResult {
  const plannedAt = Date.now();
  const skew = plannedAt - group.plannedAt;
  const margin = config.launchLead - skew;

  if (margin < (config.launchSafetyMs ?? 250)) {
    return {
      ok: false,
      reason: `planning consumed ${skew}ms of the ${config.launchLead}ms lead`,
    };
  }

  // Commit-time RAM check against live free RAM, home reserve included.
  /** @type {Map<string, number>} */
  const needed = new Map();
  for (const fragment of allocations) {
    const ram = fragment.threads * fragment.ramPerThread;
    needed.set(fragment.host, (needed.get(fragment.host) ?? 0) + ram);
  }

  for (const [host, ram] of needed) {
    const reserve = host === "home" ? config.homeReserve : 0;
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
    if (free + 1e-9 < ram) {
      return { ok: false, reason: `${host} free RAM changed during planning` };
    }
  }

  const files = Object.values(WORKER_FILES);
  const allocationHosts = new Set(allocations.map((fragment) => fragment.host));
  for (const host of allocationHosts) {
    if (host === "home") continue;
    if (!files.every((file) => ns.fileExists(file, host))) {
      return {
        ok: false,
        reason: `${host} worker files changed during planning`,
      };
    }
  }

  let fresh: Observation;
  try {
    const server = ns.getServer(group.target);
    const maxMoney = Number(server.moneyMax ?? 0);
    const security = Number(server.hackDifficulty ?? 100);
    const minSecurity = Number(server.minDifficulty ?? security);
    fresh = {
      valid:
        server.hasAdminRights === true &&
        !server.purchasedByPlayer &&
        maxMoney > 0,
      observedAt: plannedAt,
      money: Number(server.moneyAvailable ?? 0),
      maxMoney,
      security,
      minSecurity,
      hackTime: 0,
      growTime: 0,
      weakenTime: 0,
    };
  } catch {
    return {
      ok: false,
      reason: `${group.target} target read failed at commit`,
    };
  }

  const targetCheck = isStillCommittable({
    group,
    currentGeneration,
    fresh,
    config,
  });
  if (!targetCheck.ok) {
    return { ok: false, reason: targetCheck.reason };
  }

  const ordered = [...allocations].sort((a, b) => a.delay - b.delay);
  /** @type {number[]} */
  const pids = [];

  for (const fragment of ordered) {
    const args = [...fragment.args];
    args[2] = plannedAt;

    const pid = ns.exec(
      fragment.script,
      fragment.host,
      { threads: fragment.threads, temporary: true },
      ...args,
    );

    if (pid === 0) {
      for (const launched of pids) ns.kill(launched);
      const stillAlive = pids.filter((launched) =>
        ns.isRunning(launched),
      ).length;
      return {
        ok: false,
        reason: `exec failed on ${fragment.host} for ${fragment.logicalJobId}`,
        rolledBack: pids.length - stillAlive,
      };
    }

    pids.push(pid);
  }

  return { ok: true, pids, plannedAt, allocations: ordered };
}

/**
 * Poll every live receipt and reclassify it. Pure classification lives in
 * multi-planning.ts; this only supplies liveness.
 *
 * @param {NS} ns
 * @param {InFlightLedger} inFlight
 * @param {SchedulerConfig} config
 * @param {number} now
 * @returns {{ledger: InFlightLedger, changed: {receiptId: string, status: string}[]}}
 */
export function pollReceipts(
  ns: NS,
  inFlight: InFlightLedger,
  config: SchedulerConfig,
  now: number,
  fullSweep = true,
): PollResult {
  let ledger = inFlight;
  const changed: ReceiptChange[] = [];

  for (const receipt of inFlight.receipts) {
    if (!isLiveStatus(receipt.status)) continue;
    if (!fullSweep && now < receipt.expectedEndAt) continue;

    const running = ns.isRunning(receipt.pid, receipt.runner);
    const status = classifyReceipt(receipt, {
      isRunning: running,
      now,
      config,
    });

    if (status !== receipt.status) {
      ledger = applyReceiptStatus(ledger, receipt.receiptId, status, now);
      changed.push({ receiptId: receipt.receiptId, status });
    }
  }

  return { ledger, changed };
}

/**
 * Find workers this manager tagged in a previous life. Recovered processes are
 * tracked to termination; their targets are never trusted to be mid-plan.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @param {SchedulerConfig} config
 * @returns {RecoveredWorker[]}
 */
export function recoverTaggedProcesses(
  ns: NS,
  hosts: string[],
  config: SchedulerConfig,
): RecoveredWorker[] {
  const files = new Set<string>(Object.values(WORKER_FILES));
  const prefix = `${config.tagPrefix ?? "mm"}-`;
  /** @type {RecoveredWorker[]} */
  const found = [];

  for (const host of hosts) {
    if (!ns.hasRootAccess(host)) continue;

    for (const process of ns.ps(host)) {
      if (!files.has(process.filename)) continue;

      const groupTag = String(process.args[3] ?? "");
      if (!groupTag.startsWith(prefix)) continue;

      found.push({
        host,
        pid: process.pid,
        target: String(process.args[0] ?? ""),
        label: String(process.args[4] ?? ""),
      });
    }
  }

  return found;
}

/**
 * @param {NS} ns
 * @param {RecoveredWorker[]} recovered
 * @returns {RecoveredWorker[]}
 */
export function pruneDeadRecovered(
  ns: NS,
  recovered: RecoveredWorker[],
): RecoveredWorker[] {
  return recovered.filter((entry) => ns.isRunning(entry.pid, entry.host));
}
