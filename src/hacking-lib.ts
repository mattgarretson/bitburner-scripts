/**
 * Shared planning helpers for manager.ts.
 *
 * The manager intentionally keeps all orchestration in manager.ts and all
 * calculation/allocation details here. That makes the main loop readable
 * without sacrificing a competent distributed batcher.
 */

export const WORKER_FILES = {
  hack: "worker-hack.ts",
  grow: "worker-grow.ts",
  weaken: "worker-weaken.ts",
} as const;

// Bitburner's server-growth constants. These are used only to translate the
// live growthAnalyze() result to the same server at minimum security.
const SERVER_BASE_GROWTH_INCR = 0.03;
const SERVER_MAX_GROWTH_LOG = 0.00349388925425578;

export type WorkerFile = { file: string; ram: number };
export type Workers = {
  hack: WorkerFile;
  grow: WorkerFile;
  weaken: WorkerFile;
};

export type Config = {
  hackFraction: number;
  minimumHackFraction: number;
  homeReserve: number;
  landingGap: number;
  maxBatches: number;
  launchLead: number;
};

export type NetworkStats = {
  known: number;
  rooted: number;
  runners: number;
  freeRam: number;
  usableRam: number;
};

export type UnknownTarget = {
  host: string;
  valid: false;
  reason: string;
};

export type ReadyTarget = {
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

export type TargetInfo = UnknownTarget | ReadyTarget;

export type PreparedMetrics = {
  maxMoney: number;
  minSecurity: number;
  hackPercent: number;
  hackChance: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
};

export type Batch = {
  host: string;
  maxMoney: number;
  hackChance: number;
  hackPercent: number;
  actualFraction: number;
  expectedMoney: number;
  hackThreads: number;
  growThreads: number;
  weakenHackThreads: number;
  weakenGrowThreads: number;
  ramNeeded: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
};

export type RankingRow = {
  host: string;
  score: number;
  expectedPerSecond: number;
  expectedPerWave: number;
  batches: number;
  waveMs: number;
  batch: Batch;
};

export type Job = {
  script: string;
  ram: number;
  threads: number;
  delay: number;
  args: Array<string | number>;
};

export type Allocation = {
  host: string;
  script: string;
  threads: number;
  delay: number;
  args: Array<string | number>;
};

export type MoneyPrepResult = {
  growThreads: number;
  weakenThreads: number;
  neededGrowThreads: number;
  jobs: Job[];
  allocation: Allocation[];
};

export type WaveResult = {
  count: number;
  jobs: Job[];
  allocation: Allocation[];
};

export type LaunchResult =
  | { ok: true; pids: number[]; plannedAt: number }
  | { ok: false; pids: number[] };

export function loadWorkers(ns: NS): Workers | null {
  for (const file of Object.values(WORKER_FILES)) {
    if (!ns.fileExists(file, "home")) {
      ns.tprint(`ERROR: Missing ${file} on home.`);
      return null;
    }
  }

  const workers = {
    hack: {
      file: WORKER_FILES.hack,
      ram: ns.getScriptRam(WORKER_FILES.hack, "home"),
    },
    grow: {
      file: WORKER_FILES.grow,
      ram: ns.getScriptRam(WORKER_FILES.grow, "home"),
    },
    weaken: {
      file: WORKER_FILES.weaken,
      ram: ns.getScriptRam(WORKER_FILES.weaken, "home"),
    },
  };

  if (Object.values(workers).some((worker) => worker.ram <= 0)) {
    ns.tprint("ERROR: Could not determine worker RAM costs.");
    return null;
  }

  return workers;
}

export function scanNetwork(ns: NS): string[] {
  const seen = new Set<string>(["home"]);
  const stack: string[] = ["home"];

  while (stack.length > 0) {
    const host = stack.pop();
    if (host === undefined) break;
    for (const neighbor of ns.scan(host)) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      stack.push(neighbor);
    }
  }

  return [...seen];
}

/**
 * Opens every port for which we own a program, then attempts NUKE.
 * Hacking level is deliberately irrelevant here: rooted high-level servers
 * are still useful as RAM hosts.
 */
export function rootAvailableServers(ns: NS, hosts: string[]): number {
  const crackers: Array<[string, (host: string) => void]> = [
    ["BruteSSH.exe", (host) => ns.brutessh(host)],
    ["FTPCrack.exe", (host) => ns.ftpcrack(host)],
    ["relaySMTP.exe", (host) => ns.relaysmtp(host)],
    ["HTTPWorm.exe", (host) => ns.httpworm(host)],
    ["SQLInject.exe", (host) => ns.sqlinject(host)],
  ];

  let rooted = 0;

  for (const host of hosts) {
    if (host === "home" || ns.hasRootAccess(host)) continue;

    for (const [program, crack] of crackers) {
      if (ns.fileExists(program, "home")) crack(host);
    }

    if (ns.nuke(host)) rooted++;
  }

  return rooted;
}

/**
 * Copies workers only to newly seen/missing hosts instead of SCPing the entire
 * network every loop.
 */
export function deployWorkers(
  ns: NS,
  hosts: string[],
  deployedHosts: Set<string>,
): number {
  const files = Object.values(WORKER_FILES);
  let copied = 0;

  for (const host of hosts) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;

    const missing = files.some((file) => !ns.fileExists(file, host));
    if (!missing && deployedHosts.has(host)) continue;

    if (ns.scp(files, host, "home")) {
      deployedHosts.add(host);
      copied++;
    }
  }

  return copied;
}

export function getRunners(
  ns: NS,
  hosts: string[],
  homeReserve: number,
): string[] {
  return hosts
    .filter((host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0)
    .sort((a, b) => {
      if (a === "home") return 1;
      if (b === "home") return -1;
      return ns.getServerMaxRam(b) - ns.getServerMaxRam(a);
    })
    .filter((host) => freeRam(ns, host, homeReserve) > 0.01);
}

export function getNetworkStats(
  ns: NS,
  hosts: string[],
  runners: string[],
  homeReserve: number,
): NetworkStats {
  const usableRam = runners.reduce(
    (sum, host) =>
      sum +
      Math.max(
        0,
        ns.getServerMaxRam(host) - (host === "home" ? homeReserve : 0),
      ),
    0,
  );

  return {
    known: hosts.length,
    rooted: hosts.filter((host) => ns.hasRootAccess(host)).length,
    runners: runners.length,
    freeRam: totalFreeRam(ns, runners, homeReserve),
    usableRam,
  };
}

export function inspectTarget(ns: NS, host: string): TargetInfo {
  if (!host || !ns.serverExists(host)) {
    return { host, valid: false, reason: `Unknown target: ${host}` };
  }

  const server = ns.getServer(host);
  const maxMoney = server.moneyMax ?? 0;
  const requiredLevel = server.requiredHackingSkill ?? Infinity;

  if (server.purchasedByPlayer || maxMoney <= 0) {
    return { host, valid: false, reason: `${host} is not a money server` };
  }
  if (!ns.hasRootAccess(host)) {
    return { host, valid: false, reason: `No root access on ${host}` };
  }
  if (requiredLevel > ns.getHackingLevel()) {
    return {
      host,
      valid: false,
      reason: `${host} requires hacking level ${requiredLevel}`,
    };
  }

  return {
    host,
    valid: true,
    money: server.moneyAvailable ?? 0,
    maxMoney,
    security: server.hackDifficulty ?? 100,
    minSecurity: server.minDifficulty ?? 100,
    requiredLevel,
    hackTime: ns.getHackTime(host),
    growTime: ns.getGrowTime(host),
    weakenTime: ns.getWeakenTime(host),
  };
}

/**
 * Rank targets by the expected dollars/second this manager can produce with
 * its current RAM, configured batch count, gap, and maximum hack fraction.
 *
 * Unlike the old scout heuristic, this pays for the grow and both weakens.
 */
export function rankTargets(
  ns: NS,
  hosts: string[],
  workers: Workers,
  config: Config,
  availableRam: number,
): RankingRow[] {
  const rows: RankingRow[] = [];

  for (const host of hosts) {
    if (!isHackableMoneyServer(ns, host)) continue;

    const batch = buildPreparedBatch(ns, host, workers, config, availableRam);
    if (!batch) continue;

    const batches = Math.max(
      1,
      Math.min(config.maxBatches, Math.floor(availableRam / batch.ramNeeded)),
    );
    const waveMs =
      config.launchLead +
      batch.weakenTime +
      (batches - 1) * 4 * config.landingGap +
      3 * config.landingGap;
    const expectedPerWave = batch.expectedMoney * batches;
    const expectedPerSecond = expectedPerWave / Math.max(0.001, waveMs / 1_000);

    rows.push({
      host,
      score: expectedPerSecond,
      expectedPerSecond,
      expectedPerWave,
      batches,
      waveMs,
      batch,
    });
  }

  rows.sort((a, b) => b.score - a.score || b.batch.maxMoney - a.batch.maxMoney);
  return rows;
}

/**
 * Build a complete batch for a hypothetical prepared target. The requested
 * hack fraction is reduced only when the current network cannot fit one batch.
 */
export function buildPreparedBatch(
  ns: NS,
  host: string,
  workers: Workers,
  config: Config,
  availableRam: number,
): Batch | null {
  const metrics = getPreparedMetrics(ns, host);
  if (!metrics || metrics.hackPercent <= 0 || metrics.hackChance <= 0)
    return null;

  for (
    let requestedFraction = config.hackFraction;
    requestedFraction >= config.minimumHackFraction - 1e-12;
    requestedFraction *= 0.8
  ) {
    const hackThreads = Math.max(
      1,
      Math.floor(requestedFraction / metrics.hackPercent),
    );
    const actualFraction = hackThreads * metrics.hackPercent;

    // A one-thread hack can exceed the requested fraction. That is fine, but
    // draining nearly the entire server makes batching unstable and expensive.
    if (actualFraction <= 0 || actualFraction >= 0.9) continue;

    const growMultiplier = 1 / (1 - actualFraction);
    const growThreads = Math.max(
      1,
      Math.ceil(
        growthThreadsAtSecurity(ns, host, growMultiplier, metrics.minSecurity),
      ),
    );
    const weakenHackThreads = weakenThreadsForHack(ns, hackThreads);
    const weakenGrowThreads = weakenThreadsForGrow(ns, growThreads);

    const ramNeeded =
      hackThreads * workers.hack.ram +
      growThreads * workers.grow.ram +
      (weakenHackThreads + weakenGrowThreads) * workers.weaken.ram;

    if (ramNeeded > availableRam + 1e-9) continue;

    return {
      host,
      maxMoney: metrics.maxMoney,
      hackChance: metrics.hackChance,
      hackPercent: metrics.hackPercent,
      actualFraction,
      expectedMoney: metrics.maxMoney * actualFraction * metrics.hackChance,
      hackThreads,
      growThreads,
      weakenHackThreads,
      weakenGrowThreads,
      ramNeeded,
      hackTime: metrics.hackTime,
      growTime: metrics.growTime,
      weakenTime: metrics.weakenTime,
    };
  }

  return null;
}

function getPreparedMetrics(ns: NS, host: string): PreparedMetrics | null {
  const server = ns.getServer(host);
  const maxMoney = server.moneyMax ?? 0;
  const currentSecurity = server.hackDifficulty ?? 100;
  const minSecurity = server.minDifficulty ?? currentSecurity;

  if (maxMoney <= 0 || currentSecurity >= 100 || minSecurity <= 0) return null;

  // hack percent and chance are linear in (100 - security).
  const successScale =
    (100 - minSecurity) / Math.max(0.000001, 100 - currentSecurity);

  // H/G/W time is linear in security.
  const timeScale = minSecurity / Math.max(minSecurity, currentSecurity);

  return {
    maxMoney,
    minSecurity,
    hackPercent: clamp(ns.hackAnalyze(host) * successScale, 0, 1),
    hackChance: clamp(ns.hackAnalyzeChance(host) * successScale, 0, 1),
    hackTime: ns.getHackTime(host) * timeScale,
    growTime: ns.getGrowTime(host) * timeScale,
    weakenTime: ns.getWeakenTime(host) * timeScale,
  };
}

/**
 * growthAnalyze() uses current security. This translates that result to a
 * hypothetical security level by scaling the game's adjusted growth log.
 */
function growthThreadsAtSecurity(
  ns: NS,
  host: string,
  multiplier: number,
  targetSecurity: number,
): number {
  const currentSecurity = ns.getServerSecurityLevel(host);
  const liveThreads = ns.growthAnalyze(host, multiplier, 1);

  if (!Number.isFinite(liveThreads) || liveThreads <= 0) return liveThreads;

  const currentGrowthLog = adjustedGrowthLog(currentSecurity);
  const targetGrowthLog = adjustedGrowthLog(targetSecurity);
  return liveThreads * (currentGrowthLog / targetGrowthLog);
}

function adjustedGrowthLog(security: number): number {
  return Math.min(
    Math.log1p(SERVER_BASE_GROWTH_INCR / Math.max(1, security)),
    SERVER_MAX_GROWTH_LOG,
  );
}

export function weakenThreadsForHack(ns: NS, hackThreads: number): number {
  return Math.max(
    1,
    Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / ns.weakenAnalyze(1, 1)),
  );
}

export function weakenThreadsForGrow(ns: NS, growThreads: number): number {
  // No hostname: a hostname can cap this against the target's current money,
  // which is wrong when planning growth that occurs after a future hack.
  return Math.max(
    1,
    Math.ceil(
      ns.growthAnalyzeSecurity(growThreads, undefined, 1) /
        ns.weakenAnalyze(1, 1),
    ),
  );
}

/**
 * Find the largest grow + compensating-weaken prep that currently fits.
 */
export function planMoneyPrep(
  ns: NS,
  target: ReadyTarget,
  runners: string[],
  workers: Workers,
  config: Config,
  serial: string,
): MoneyPrepResult | null {
  const multiplier = target.maxMoney / Math.max(1, target.money);
  let neededGrowThreads = Math.ceil(
    ns.growthAnalyze(target.host, multiplier, 1),
  );

  if (!Number.isFinite(neededGrowThreads) || neededGrowThreads < 1) {
    neededGrowThreads = 1_000_000_000;
  }

  const growCapacity = totalThreadCapacity(
    ns,
    runners,
    workers.grow.ram,
    config.homeReserve,
  );
  let low = 1;
  let high = Math.min(neededGrowThreads, growCapacity);
  let best: MoneyPrepResult | null = null;

  while (low <= high) {
    const growThreads = Math.floor((low + high) / 2);
    const weakenThreads = weakenThreadsForGrow(ns, growThreads);
    const jobs = makeMoneyPrepJobs(
      target,
      workers,
      config,
      growThreads,
      weakenThreads,
      serial,
    );
    const allocation = allocateJobs(ns, runners, jobs, config.homeReserve);

    if (allocation) {
      best = {
        growThreads,
        weakenThreads,
        neededGrowThreads,
        jobs,
        allocation,
      };
      low = growThreads + 1;
    } else {
      high = growThreads - 1;
    }
  }

  return best;
}

function makeMoneyPrepJobs(
  target: ReadyTarget,
  workers: Workers,
  config: Config,
  growThreads: number,
  weakenThreads: number,
  serial: string,
): Job[] {
  const growDelay =
    config.launchLead + Math.max(0, target.weakenTime - target.growTime);
  return [
    makeJob(
      workers.grow,
      growThreads,
      target.host,
      growDelay,
      serial,
      "PREP-G",
    ),
    makeJob(
      workers.weaken,
      weakenThreads,
      target.host,
      config.launchLead + config.landingGap,
      serial,
      "PREP-W",
    ),
  ];
}

/**
 * Build and allocate the largest complete wave that fits right now.
 * All batches are planned before any process is launched.
 */
export function planLargestWave(
  ns: NS,
  target: ReadyTarget,
  batch: Batch,
  runners: string[],
  workers: Workers,
  config: Config,
  serial: string,
): WaveResult | null {
  let low = 1;
  let high = config.maxBatches;
  let best: WaveResult | null = null;

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const jobs = makeWaveJobs(
      target.host,
      batch,
      workers,
      config,
      count,
      serial,
    );
    const allocation = allocateJobs(ns, runners, jobs, config.homeReserve);

    if (allocation) {
      best = { count, jobs, allocation };
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return best;
}

function makeWaveJobs(
  host: string,
  batch: Batch,
  workers: Workers,
  config: Config,
  batchCount: number,
  serial: string,
): Job[] {
  const jobs: Job[] = [];
  const batchSpacing = 4 * config.landingGap;

  for (let index = 0; index < batchCount; index++) {
    const offset = index * batchSpacing;
    const id = `${serial}-${index}`;

    jobs.push(
      makeJob(
        workers.hack,
        batch.hackThreads,
        host,
        config.launchLead +
          Math.max(0, batch.weakenTime - batch.hackTime) +
          offset,
        id,
        "H",
      ),
      makeJob(
        workers.weaken,
        batch.weakenHackThreads,
        host,
        config.launchLead + config.landingGap + offset,
        id,
        "W1",
      ),
      makeJob(
        workers.grow,
        batch.growThreads,
        host,
        config.launchLead +
          Math.max(0, batch.weakenTime - batch.growTime) +
          2 * config.landingGap +
          offset,
        id,
        "G",
      ),
      makeJob(
        workers.weaken,
        batch.weakenGrowThreads,
        host,
        config.launchLead + 3 * config.landingGap + offset,
        id,
        "W2",
      ),
    );
  }

  return jobs;
}

export function makeSecurityPrepJob(
  target: ReadyTarget,
  workers: Workers,
  config: Config,
  threads: number,
  serial: string,
): Job {
  return makeJob(
    workers.weaken,
    threads,
    target.host,
    config.launchLead,
    serial,
    "PREP-W",
  );
}

function makeJob(
  worker: WorkerFile,
  threads: number,
  target: string,
  delay: number,
  id: string,
  label: string,
): Job {
  return {
    script: worker.file,
    ram: worker.ram,
    threads,
    delay: Math.max(0, Math.floor(delay)),
    args: [target, Math.max(0, Math.floor(delay)), 0, id, label],
  };
}

/**
 * Greedy distributed allocation. It plans against a private RAM ledger, so a
 * returned plan is complete; null means at least one job could not fit.
 */
export function allocateJobs(
  ns: NS,
  runners: string[],
  jobs: Job[],
  homeReserve: number,
): Allocation[] | null {
  const freeByHost = new Map<string, number>(
    runners.map((host) => [host, freeRam(ns, host, homeReserve)]),
  );
  const allocations: Allocation[] = [];

  const orderedJobs = [...jobs].sort(
    (a, b) => b.ram - a.ram || b.threads - a.threads || a.delay - b.delay,
  );

  for (const job of orderedJobs) {
    let remaining = job.threads;
    const orderedHosts = [...runners].sort((a, b) => {
      if (a === "home") return 1;
      if (b === "home") return -1;
      return (freeByHost.get(b) ?? 0) - (freeByHost.get(a) ?? 0);
    });

    for (const host of orderedHosts) {
      if (remaining <= 0) break;

      const free = freeByHost.get(host) ?? 0;
      const capacity = Math.floor(free / job.ram);
      const threads = Math.min(remaining, capacity);
      if (threads < 1) continue;

      allocations.push({
        host,
        script: job.script,
        threads,
        delay: job.delay,
        args: [...job.args],
      });

      freeByHost.set(host, free - threads * job.ram);
      remaining -= threads;
    }

    if (remaining > 0) return null;
  }

  return allocations;
}

/**
 * Starts an entire allocation or rolls back every PID already launched.
 * Workers compensate for launch skew using plannedAt.
 */
export function launchAtomic(
  ns: NS,
  allocations: Allocation[],
  plannedAt = Date.now(),
): LaunchResult {
  const launchedPids: number[] = [];
  const ordered = [...allocations].sort((a, b) => a.delay - b.delay);

  for (const item of ordered) {
    const args = [...item.args];
    args[2] = plannedAt;

    const pid = ns.exec(
      item.script,
      item.host,
      { threads: item.threads, temporary: true },
      ...args,
    );

    if (pid === 0) {
      for (const launchedPid of launchedPids) ns.kill(launchedPid);
      return { ok: false, pids: [] };
    }

    launchedPids.push(pid);
  }

  return { ok: true, pids: launchedPids, plannedAt };
}

export function totalThreadCapacity(
  ns: NS,
  hosts: string[],
  scriptRam: number,
  homeReserve: number,
): number {
  return hosts.reduce(
    (sum, host) => sum + Math.floor(freeRam(ns, host, homeReserve) / scriptRam),
    0,
  );
}

export function totalFreeRam(
  ns: NS,
  hosts: string[],
  homeReserve: number,
): number {
  return hosts.reduce((sum, host) => sum + freeRam(ns, host, homeReserve), 0);
}

export function freeRam(ns: NS, host: string, homeReserve: number): number {
  const reserve = host === "home" ? homeReserve : 0;
  return Math.max(
    0,
    ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve,
  );
}

export function waveDuration(
  config: Config,
  batch: Batch,
  batchCount: number,
): number {
  return (
    config.launchLead +
    batch.weakenTime +
    (batchCount - 1) * 4 * config.landingGap +
    3 * config.landingGap
  );
}

export function describeBatch(batch: Batch): string {
  return (
    `H${batch.hackThreads}/W${batch.weakenHackThreads}/` +
    `G${batch.growThreads}/W${batch.weakenGrowThreads}`
  );
}

export function formatRam(gb: number): string {
  if (gb >= 1_024) return `${(gb / 1_024).toFixed(2)} TB`;
  return `${gb.toFixed(1)} GB`;
}

function isHackableMoneyServer(ns: NS, host: string): boolean {
  if (!host || !ns.serverExists(host) || !ns.hasRootAccess(host)) return false;

  const server = ns.getServer(host);
  if (server.purchasedByPlayer || (server.moneyMax ?? 0) <= 0) return false;
  return (server.requiredHackingSkill ?? Infinity) <= ns.getHackingLevel();
}

/** Shared by every script that reads a numeric flag; non-finite input floors. */
export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
