/**
 * Shared Netscript helpers: network scan/root/deploy, worker costs, target
 * inspection, and the prepared-batch model used to size and rank targets.
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
const HACK_TIME_DIFF_FACTOR = 2.5;
const HACK_TIME_BASE_DIFF = 500;

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
  growSafetyMargin?: number;
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
 * This pays for the grow and both weakens, not just the hack.
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
    const growThreads = applyGrowSafetyMargin(
      growthThreadsAtSecurity(ns, host, growMultiplier, metrics.minSecurity),
      config.growSafetyMargin ?? 0,
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

export function applyGrowSafetyMargin(threads: number, margin: number): number {
  if (!Number.isFinite(threads)) return threads;
  return Math.max(1, Math.ceil(threads * (1 + Math.max(0, margin))));
}

export function hackTimeScale(
  requiredSkill: number | null | undefined,
  fromSecurity: number,
  toSecurity: number,
): number {
  const skill =
    typeof requiredSkill === "number" && Number.isFinite(requiredSkill)
      ? Math.max(0, requiredSkill)
      : 0;
  const from = Math.max(0, fromSecurity);
  const to = Math.max(0, toSecurity);
  const at = (security: number): number =>
    HACK_TIME_DIFF_FACTOR * skill * security + HACK_TIME_BASE_DIFF;
  return at(to) / at(from);
}

function getPreparedMetrics(ns: NS, host: string): PreparedMetrics | null {
  const server = ns.getServer(host);
  const maxMoney = server.moneyMax ?? 0;
  const currentSecurity = server.hackDifficulty ?? 100;
  const minSecurity = server.minDifficulty ?? currentSecurity;
  const requiredLevel = server.requiredHackingSkill;

  if (maxMoney <= 0 || currentSecurity >= 100 || minSecurity <= 0) return null;

  // hack percent and chance are linear in (100 - security).
  const successScale =
    (100 - minSecurity) / Math.max(0.000001, 100 - currentSecurity);

  // H/G/W time shares the same affine difficulty factor.
  const timeScale = hackTimeScale(requiredLevel, currentSecurity, minSecurity);

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
export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
