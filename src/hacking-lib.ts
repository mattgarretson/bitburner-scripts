/**
 * Shared Netscript helpers: network scan/root/deploy, worker costs, and the
 * prepared-batch model used to size batches and rank targets.
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

/** How buildPreparedBatch sizes a batch. */
export type Config = {
  hackFraction: number;
  minimumHackFraction: number;
  growSafetyMargin?: number;
  /**
   * Hacking levels you are gaining per millisecond. Each level makes a hack
   * steal a little more, so grow is sized for your level when the hack lands.
   */
  levelsPerMs?: number;
};

type PreparedMetrics = {
  maxMoney: number;
  minSecurity: number;
  requiredLevel: number;
  hackPercent: number;
  hackChance: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
};

export type Batch = {
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
  const drift = hackDrift(ns, metrics, config.levelsPerMs ?? 0);

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

    // Grow must refill what the hack takes at the level it lands with.
    const landingFraction = Math.min(0.95, actualFraction * drift);
    const growMultiplier = 1 / (1 - landingFraction);
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

/**
 * How much more a hack steals by the time it lands, a weaken time from now,
 * at `levelsPerMs`: what a thread steals scales with (level - required + 1) /
 * level.
 */
function hackDrift(
  ns: NS,
  metrics: PreparedMetrics,
  levelsPerMs: number,
): number {
  // Types are erased at runtime, so anything but a real rate means no drift.
  if (!(Number.isFinite(levelsPerMs) && levelsPerMs > 0)) return 1;
  const level = ns.getHackingLevel();
  const landingLevel = level + levelsPerMs * metrics.weakenTime;
  const factor = (at: number): number => (at - metrics.requiredLevel + 1) / at;
  const drift = factor(landingLevel) / factor(level);
  return Number.isFinite(drift) && drift > 1 ? drift : 1;
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

  if (maxMoney <= 0 || minSecurity <= 0) return null;
  const odds = oddsAtMinimumSecurity(ns, host, server);
  if (!odds) return null;

  // H/G/W time shares the same affine difficulty factor.
  const timeScale = hackTimeScale(requiredLevel, currentSecurity, minSecurity);

  return {
    maxMoney,
    minSecurity,
    requiredLevel: requiredLevel ?? 1,
    hackPercent: clamp(odds.percent, 0, 1),
    hackChance: clamp(odds.chance, 0, 1),
    hackTime: ns.getHackTime(host) * timeScale,
    growTime: ns.getGrowTime(host) * timeScale,
    weakenTime: ns.getWeakenTime(host) * timeScale,
  };
}

/**
 * Hack percent and chance once the server is at minimum security. Both are
 * linear in (100 - security), so the live answers scale down to the minimum.
 * At 100 security they read 0, and only Formulas.exe can answer, if you have it.
 */
function oddsAtMinimumSecurity(
  ns: NS,
  host: string,
  server: ReturnType<NS["getServer"]>,
): { percent: number; chance: number } | null {
  const security = server.hackDifficulty ?? 100;
  const minSecurity = server.minDifficulty ?? security;
  if (security < 100) {
    const scale = (100 - minSecurity) / (100 - security);
    return {
      percent: ns.hackAnalyze(host) * scale,
      chance: ns.hackAnalyzeChance(host) * scale,
    };
  }
  if (!ns.fileExists("Formulas.exe", "home")) return null;

  const prepared = { ...server, hackDifficulty: minSecurity };
  const player = ns.getPlayer();
  return {
    percent: ns.formulas.hacking.hackPercent(prepared, player),
    chance: ns.formulas.hacking.hackChance(prepared, player),
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

function weakenThreadsForHack(ns: NS, hackThreads: number): number {
  return Math.max(
    1,
    Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / ns.weakenAnalyze(1, 1)),
  );
}

function weakenThreadsForGrow(ns: NS, growThreads: number): number {
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

/** Non-finite input gives the minimum. */
function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
