/**
 * Shared Netscript helpers: network scan/root/deploy, worker costs, and the
 * prepared-batch model used to size batches and rank targets. The batch model
 * prices everything with Formulas.exe, so it needs Formulas.exe on home.
 */

export const WORKER_FILES = {
  hack: "worker-hack.ts",
  grow: "worker-grow.ts",
  weaken: "worker-weaken.ts",
} as const;

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

type Player = ReturnType<NS["getPlayer"]>;
type Server = ReturnType<NS["getServer"]>;

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
 * Build a complete batch for the target as it will be once prepped, at
 * minimum security and maximum money, priced by Formulas.exe. The requested
 * hack fraction is reduced only when the current network cannot fit one batch.
 */
export function buildPreparedBatch(
  ns: NS,
  host: string,
  workers: Workers,
  config: Config,
  availableRam: number,
): Batch | null {
  const server = ns.getServer(host);
  const maxMoney = server.moneyMax ?? 0;
  if (maxMoney <= 0) return null;
  const prepped = {
    ...server,
    hackDifficulty: server.minDifficulty,
    moneyAvailable: maxMoney,
  };
  const player = ns.getPlayer();
  const formulas = ns.formulas.hacking;
  const hackPercent = formulas.hackPercent(prepped, player);
  const hackChance = formulas.hackChance(prepped, player);
  if (!(hackPercent > 0 && hackChance > 0)) return null;
  const weakenTime = formulas.weakenTime(prepped, player);
  // A thread steals more at each level, so grow is sized for the level the
  // hack lands with, a weaken time from now.
  const landing = atLevel(player, landingLevel(player, config, weakenTime));
  const landingPercent = formulas.hackPercent(prepped, landing);

  for (
    let requestedFraction = config.hackFraction;
    requestedFraction >= config.minimumHackFraction - 1e-12;
    requestedFraction *= 0.8
  ) {
    const hackThreads = Math.max(
      1,
      Math.floor(requestedFraction / hackPercent),
    );
    const actualFraction = hackThreads * hackPercent;

    // A one-thread hack can exceed the requested fraction. That is fine, but
    // draining nearly the entire server makes batching unstable and expensive.
    if (actualFraction >= 0.9) continue;

    const landingFraction = Math.min(0.95, hackThreads * landingPercent);
    const growThreads = growThreadsFor(
      ns,
      prepped,
      player,
      1 / (1 - landingFraction),
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
      expectedMoney: maxMoney * actualFraction * hackChance,
      hackThreads,
      growThreads,
      weakenHackThreads,
      weakenGrowThreads,
      ramNeeded,
      hackTime: formulas.hackTime(prepped, player),
      growTime: formulas.growTime(prepped, player),
      weakenTime,
    };
  }

  return null;
}

/** The hacking level a hack launched now lands with, at `levelsPerMs`. */
function landingLevel(
  player: Player,
  config: Config,
  weakenTime: number,
): number {
  const level = player.skills.hacking;
  const levelsPerMs = config.levelsPerMs ?? 0;
  // Types are erased at runtime, so anything but a real rate means no leveling.
  if (!(Number.isFinite(levelsPerMs) && levelsPerMs > 0)) return level;
  return level + levelsPerMs * weakenTime;
}

/** The player as they will be at another hacking level. */
function atLevel(player: Player, level: number): Player {
  return { ...player, skills: { ...player.skills, hacking: level } };
}

/**
 * Grow threads that multiply the money on `server`, at its security as given,
 * by `multiplier`, plus `margin` more; Infinity if it can't grow. Sized from
 * the growth per thread, not Formulas.exe's growThreads: that one is exact
 * for a single grow and rounds up before the margin is added. In simulation
 * it cost extra prep cycles, likely because a grow split across servers lands
 * piece by piece, each piece raising security for the next.
 */
export function growThreadsFor(
  ns: NS,
  server: Server,
  player: Player,
  multiplier: number,
  margin: number,
): number {
  const perThread = Math.log(
    ns.formulas.hacking.growPercent(server, 1, player),
  );
  if (!(perThread > 0)) return Infinity;
  return applyGrowSafetyMargin(Math.log(multiplier) / perThread, margin);
}

export function applyGrowSafetyMargin(threads: number, margin: number): number {
  if (!Number.isFinite(threads)) return threads;
  return Math.max(1, Math.ceil(threads * (1 + Math.max(0, margin))));
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
