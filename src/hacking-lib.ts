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

/** A batch too big for the network is tried again, stealing this much less. */
const FRACTION_STEP = 0.8;
/**
 * A batch never steals this much or more. A one-thread hack can steal more
 * than was asked for, and draining nearly a whole server makes batching
 * unstable and expensive.
 */
const MAX_STEAL_FRACTION = 0.9;
/** Grow is sized for at most this much stolen, however far the level climbs first. */
const MAX_LANDING_FRACTION = 0.95;
/** Lets float rounding still reach the smallest hack fraction. */
const FRACTION_TOLERANCE = 1e-12;
/** Lets float rounding still fit a batch that needs exactly the RAM there is. */
const RAM_TOLERANCE = 1e-9;

/** A worker script and its RAM per thread. */
export type WorkerFile = { file: string; ram: number };
export type Workers = Record<keyof typeof WORKER_FILES, WorkerFile>;

/**
 * The arguments every worker is started with. The workers read the first
 * three: they wait `delay` less the time since `plannedAt`. The manager finds
 * its own workers again by `batchId`.
 */
export type WorkerArgs = {
  target: string;
  delay: number;
  plannedAt: number;
  batchId: string;
  label: string;
};

/** How buildPreparedBatch sizes a batch. */
export type BatchSizing = {
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

/** A prepared batch: its threads, its RAM and money, and its run times in ms. */
export type Batch = {
  /** $ it steals, weighted by its hack chance. */
  expectedMoney: number;
  hackThreads: number;
  growThreads: number;
  weakenHackThreads: number;
  weakenGrowThreads: number;
  /** GB all its threads take together. */
  ramNeeded: number;
  hackTime: number;
  growTime: number;
  weakenTime: number;
};

/** Each worker's file and RAM, or null after saying in the terminal what is wrong. */
export function loadWorkers(ns: NS): Workers | null {
  for (const file of Object.values(WORKER_FILES)) {
    if (!ns.fileExists(file, "home")) {
      ns.tprint(`ERROR: Missing ${file} on home.`);
      return null;
    }
  }

  const workers: Workers = {
    hack: workerFile(ns, WORKER_FILES.hack),
    grow: workerFile(ns, WORKER_FILES.grow),
    weaken: workerFile(ns, WORKER_FILES.weaken),
  };

  if (Object.values(workers).some((worker) => worker.ram <= 0)) {
    ns.tprint("ERROR: Could not determine worker RAM costs.");
    return null;
  }

  return workers;
}

/** A worker file and its RAM per thread, as home reports it. */
function workerFile(ns: NS, file: string): WorkerFile {
  return { file, ram: ns.getScriptRam(file, "home") };
}

/** A worker's arguments, in the order ns.exec passes them. */
export function toWorkerArgs(
  args: WorkerArgs,
): [string, number, number, string, string] {
  return [args.target, args.delay, args.plannedAt, args.batchId, args.label];
}

/** The target and batch id of a running worker, from its arguments. */
export function fromWorkerArgs(
  args: ReadonlyArray<string | number | boolean>,
): Pick<WorkerArgs, "target" | "batchId"> {
  return { target: String(args[0] ?? ""), batchId: String(args[3] ?? "") };
}

/** Every server on the network, home included. */
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
export function rootAvailableServers(ns: NS, hosts: string[]): void {
  const crackers: Array<[string, (host: string) => void]> = [
    ["BruteSSH.exe", (host) => ns.brutessh(host)],
    ["FTPCrack.exe", (host) => ns.ftpcrack(host)],
    ["relaySMTP.exe", (host) => ns.relaysmtp(host)],
    ["HTTPWorm.exe", (host) => ns.httpworm(host)],
    ["SQLInject.exe", (host) => ns.sqlinject(host)],
  ];

  for (const host of hosts) {
    if (host === "home" || ns.hasRootAccess(host)) continue;

    for (const [program, crack] of crackers) {
      if (ns.fileExists(program, "home")) crack(host);
    }

    ns.nuke(host);
  }
}

/**
 * Copies the workers only to hosts that are new or missing them, instead of
 * to the whole network every time.
 */
export function deployWorkers(
  ns: NS,
  hosts: string[],
  deployedHosts: Set<string>,
): void {
  const files = Object.values(WORKER_FILES);

  for (const host of hosts) {
    if (host === "home" || !ns.hasRootAccess(host)) continue;

    const missing = files.some((file) => !ns.fileExists(file, host));
    if (!missing && deployedHosts.has(host)) continue;

    if (ns.scp(files, host, "home")) deployedHosts.add(host);
  }
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
  sizing: BatchSizing,
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
  const landing = atLevel(player, landingLevel(player, sizing, weakenTime));
  const landingPercent = formulas.hackPercent(prepped, landing);

  for (
    let requestedFraction = sizing.hackFraction;
    requestedFraction >= sizing.minimumHackFraction - FRACTION_TOLERANCE;
    requestedFraction *= FRACTION_STEP
  ) {
    const hackThreads = Math.max(
      1,
      Math.floor(requestedFraction / hackPercent),
    );
    const actualFraction = hackThreads * hackPercent;
    if (actualFraction >= MAX_STEAL_FRACTION) continue;

    const landingFraction = Math.min(
      MAX_LANDING_FRACTION,
      hackThreads * landingPercent,
    );
    const growThreads = growThreadsFor(
      ns,
      prepped,
      player,
      1 / (1 - landingFraction),
      sizing.growSafetyMargin ?? 0,
    );
    const weakenHackThreads = weakenThreadsForHack(ns, hackThreads);
    const weakenGrowThreads = weakenThreadsForGrow(ns, growThreads);

    const ramNeeded =
      hackThreads * workers.hack.ram +
      growThreads * workers.grow.ram +
      (weakenHackThreads + weakenGrowThreads) * workers.weaken.ram;

    if (ramNeeded > availableRam + RAM_TOLERANCE) continue;

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
  sizing: BatchSizing,
  weakenTime: number,
): number {
  const level = player.skills.hacking;
  const levelsPerMs = sizing.levelsPerMs ?? 0;
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

/** `threads` raised by `margin`, rounded up, and at least one. */
export function applyGrowSafetyMargin(threads: number, margin: number): number {
  if (!Number.isFinite(threads)) return threads;
  return Math.max(1, Math.ceil(threads * (1 + Math.max(0, margin))));
}

/** Weaken threads that cancel what `hackThreads` hack threads add to security. */
function weakenThreadsForHack(ns: NS, hackThreads: number): number {
  return Math.max(
    1,
    Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / ns.weakenAnalyze(1, 1)),
  );
}

/** Weaken threads that cancel what `growThreads` grow threads add to security. */
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
