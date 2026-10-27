/**
 * multi-manager.ts — hacks several servers at once with timed hack/weaken/grow/weaken batches
 *
 * Every 15 s it picks how much of a server's money a batch steals, and which
 * servers to work on: whatever its batch maths says earns the most with the
 * RAM you have, plus a few more servers to prep next. Each loop it reads
 * every target, preps the ones that aren't at minimum security and maximum
 * money, and launches waves of complete batches on the ones that are, best
 * $ per GB-second first. Everything is planned from that loop's reading,
 * because every hacking level shortens hack, grow and weaken. Batches come
 * first: prep only gets RAM no batch could use, and never RAM a waiting batch
 * will need. A wave that is still landing gets more batches appended behind
 * it whenever its target reads prepped between landings. Once all of a
 * target's workers have ended, it is read again before anything new is
 * planned for it.
 *
 * Needs Formulas.exe on home. Uses the RAM of every server you have root on,
 * home last and less --reserve GB. Won't start while another copy is
 * running, and won't kill it either. Targets with workers left over from a
 * previous copy are left alone until those workers end.
 *
 * Usage: run multi-manager.ts [--reserve 8]
 *   --reserve  GB kept free on home
 * Everything else is a constant below.
 *
 * @param {NS} ns
 */
import {
  WORKER_FILES,
  buildPreparedBatch,
  deployWorkers,
  fromWorkerArgs,
  growThreadsFor,
  loadWorkers,
  rootAvailableServers,
  scanNetwork,
  toWorkerArgs,
} from "./hacking-lib.ts";
import type { Batch, BatchSizing, WorkerFile, Workers } from "./hacking-lib.ts";

/** Milliseconds between the four landings of one batch. */
const LANDING_GAP_MS = 200;
/** Most batches in one wave. */
const MAX_BATCHES = 20;
/** Head start on every launch, so slow exec calls can't make anything land late. */
const LAUNCH_LEAD_MS = 1_000;
/** A launch is called off if planning ate the head start down below this. */
const LAUNCH_SAFETY_MS = 250;
/** How often the network is rooted and deployed to again, and targets re-picked. */
const NETWORK_REFRESH_MS = 15_000;
/** The status window's "last minute" income covers this long. */
const INCOME_WINDOW_MS = 60_000;
/** How far back the leveling rate is measured. */
const LEVELING_WINDOW_MS = 300_000;
/** How much of a server's money a batch steals: the picker chooses one of these. */
const HACK_FRACTIONS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9] as const;
/** A batch too big for the network steals less, down to this. */
const MIN_HACK_FRACTION = 0.0025;
/** The picker only changes fraction for this much more modelled income. */
const SWITCH_MARGIN = 1.05;
/** Servers kept beyond those the RAM can keep batching, so the next ones get prepped. */
const PREP_TARGETS = 3;
/** Most quick earners picked at once. */
const QUICK_TARGETS = 3;
/** A quick earner's weaken takes at most this share of the best target's. */
const QUICK_WEAKEN_SHARE = 0.5;
/** Extra grow threads, as a fraction, in case growth comes up a little short. */
const GROW_SAFETY_MARGIN = 0.02;
/**
 * How close to minimum security counts as prepped. Any security over the
 * minimum makes hack, grow and weaken run long, so this only absorbs float
 * rounding.
 */
const SECURITY_TOLERANCE = 1e-6;
/** How close to maximum money counts as prepped. */
const MONEY_READY_RATIO = 0.999;
/** How long a target sits out after a failed launch. */
const BACKOFF_MS = 5_000;
/** Most groups launched per loop. */
const LAUNCHES_PER_LOOP = 4;
/** Time allowed for launching groups in one loop. */
const LAUNCH_BUDGET_MS = 500;
/** Shortest sleep between loops. */
const MIN_SLEEP_MS = 200;
/** Longest sleep between loops; it wakes sooner when something is due. */
const MAX_SLEEP_MS = 1_000;
/** GB kept free on home unless --reserve says otherwise. */
const DEFAULT_HOME_RESERVE_GB = 8;
/**
 * Starts every group id, and so every worker's batch id: a restarted manager
 * finds its own workers by it.
 */
const GROUP_ID_PREFIX = "mm";
/** What a target waits on while a previous copy's workers on it still run. */
const LEFTOVER_GROUP_ID = "leftover";
/** Keeps prep's weaken count finite if a weaken ever removed no security. */
const MIN_WEAKEN_PER_THREAD = 1e-9;
/** RAM is counted in hundredths of a GB, so free-RAM comparisons are exact. */
const UNITS_PER_GB = 100;
const MS_PER_SECOND = 1_000;
const MS_PER_HOUR = 3_600_000;
const WORKER_FILE_LIST: readonly string[] = Object.values(WORKER_FILES);

/**
 * Where a target is, and what the status window calls it: waiting for a
 * reading, ready for prep or batches, with a group in flight, or sitting out
 * after a failed launch.
 */
const PHASES = {
  NEEDS_READING: "reading",
  UNAVAILABLE: "can't hack",
  PREP_READY: "needs prep",
  BATCH_READY: "ready",
  PREP_IN_FLIGHT: "prepping",
  BATCH_IN_FLIGHT: "batching",
  BACKOFF: "backing off",
} as const;

type Phase = keyof typeof PHASES;
type Purpose = "batch" | "prep";
type Settings = { homeReserve: number };

/**
 * Why a target is tracked. Main targets are the ones the plan keeps batching.
 * Backups are kept to be prepped next and take no batches; while a main
 * target is prepping, they are main targets too. Quick earners use RAM that
 * sits idle after a start. Retiring targets are no longer picked: they take
 * nothing new, and are dropped once their work ends.
 */
type Role = "main" | "backup" | "quick" | "retiring";

/** A target's money, security and timings, as read from the game. */
type Reading = {
  money: number;
  maxMoney: number;
  security: number;
  minSecurity: number;
  growTime: number;
  weakenTime: number;
};

/** What prepping a target takes from where it is now. */
type Prep = {
  /** Grow threads to refill its money; 0 when it is full. */
  growThreads: number;
  /** Weaken threads for the security it is already over its minimum. */
  excessWeakenThreads: number;
  growSecurityPerThread: number;
  weakenPerThread: number;
  growTime: number;
  weakenTime: number;
};

/** What a target's batches earn and what its prep needs, from its last reading. */
type Economics = {
  /** Sized for it at minimum security; null if no batch can be built. */
  batch: Batch | null;
  /** Expected $ per GB-second of RAM its batch holds; 0 without a batch. */
  moneyPerGbSecond: number;
  prep: Prep;
};

type Target = {
  host: string;
  phase: Phase;
  role: Role;
  /** Its latest reading; null before the first, or while it can't be hacked. */
  reading: Reading | null;
  economics: Economics | null;
  /** The group it is waiting on; LEFTOVER_GROUP_ID for a previous copy's workers. */
  activeGroupId: string | null;
  /** When the backoff after a failed launch ends. */
  backoffUntil: number;
  /** When its current wait began: equal targets prep longest-waiting first. */
  waitingSince: number;
  /** Batches in its current chain; appended batches are numbered on from here. */
  scheduledBatchCount: number;
  /** When the first hack of its current chain lands. */
  paysAt: number;
  /** Its launched hacks: when each lands, and the money it is planned to steal. */
  hacks: Array<{ landsAt: number; money: number }>;
};

/** Which operation a job is: one of a batch's four, or prep's grow or weaken. */
type JobLabel = "H" | "W1" | "G" | "W2" | "PREP-G" | "PREP-W";

/** One worker script run: its threads, delay and expected run time. */
type Job = {
  id: string;
  batchId: string;
  label: JobLabel;
  worker: WorkerFile;
  threads: number;
  delay: number;
  duration: number;
};

/** Jobs launched together on one target: a wave of batches, or one prep. */
type Group = {
  id: string;
  purpose: Purpose;
  target: string;
  plannedAt: number;
  jobs: Job[];
  batchCount: number;
  lastEndAt: number;
  /** Appended to a chain that is already running. */
  continuation: boolean;
};

/** Some of a job's threads, placed on one server. */
type Fragment = { job: Job; host: string; threads: number; units: number };

/** A group placed on servers, or the RAM it needs that isn't there. */
type Placement =
  | { ok: true; group: Group; fragments: Fragment[] }
  | { ok: false; requiredUnits: number };

/** Free RAM on a server with the worker files. */
type Runner = { host: string; units: number };

/** A launched worker process, kept until it ends. */
type Receipt = {
  groupId: string;
  target: string;
  host: string;
  pid: number;
  units: number;
  endsAt: number;
};

/** What launching a group did: its workers, or why it launched nothing. */
type Launch = { ok: true; receipts: Receipt[] } | { ok: false; reason: string };

type Decision =
  | {
      kind: "batch" | "prep";
      target: Target;
      group: Group;
      fragments: Fragment[];
    }
  | { kind: "idle" };

/** When a new wave can launch to land right behind a running chain. */
type AppendWindow = { lastEndAt: number; launchAt: number };

/** A running chain with its append window, or a ready target: either may take a wave. */
type WaveCandidate = { target: Target; append: AppendWindow | null };

/**
 * What the wave pass found: a wave to launch, or else the RAM left once
 * running chains hold theirs, and what the best wave that didn't fit needs.
 */
type WavePass =
  | { found: true; decision: Decision }
  | { found: false; runnersLeft: Runner[]; waitingBatchUnits: number | null };

/** What planning a group works from. `serial` keeps group ids unique. */
type PlanContext = {
  runners: Runner[];
  workers: Workers;
  now: number;
  serial: number;
};

/** A target with the batch it would run once prepped. */
type PricedTarget = { host: string; batch: Batch };

/** What batches stealing one hack fraction would earn, by the picker's model. */
type FractionPlan = {
  fraction: number;
  /** The targets it can price, best $/GB-s first. */
  ranked: PricedTarget[];
  /** How many of them the RAM can keep batching. */
  fed: number;
  /** Modelled $/s with those targets batching flat out. */
  income: number;
};

/** A worker a previous copy of this script left running. */
type LeftoverWorker = { host: string; pid: number; target: string };

/** Hacking money, level and game lag, as read in one loop. */
type Sample = { at: number; money: number; level: number; late: number };

/** A row of the status window's target table, one string per column. */
type TargetRow = {
  host: string;
  earning: string;
  activity: string;
  money: string;
  security: string;
  ram: string;
  timing: string;
};

type State = {
  settings: Settings;
  workers: Workers;
  /** Picked at each network refresh; 0 until the first. */
  hackFraction: number;
  /** Every server on the network, as of the last refresh. */
  hosts: string[];
  /** Servers the worker files have been copied to. */
  deployedHosts: Set<string>;
  /** Rooted servers with the worker files, as of the last network refresh. */
  workerHosts: Set<string>;
  /** The RAM batches are sized against: all worker RAM, ours in use or not. */
  capacityRam: number;
  /** Free RAM on each worker host, as last read. */
  runners: Runner[];
  targets: Map<string, Target>;
  /** Launched workers that haven't ended yet. */
  inFlight: Receipt[];
  leftoverWorkers: LeftoverWorker[];
  nextNetworkRefresh: number;
  /** The picked plan: how many main targets, and its modelled full-speed $/s. */
  plan: { fed: number; income: number };
  /** Hacking money at start, and the samples of the last LEVELING_WINDOW_MS. */
  progress: { moneyAtStart: number; samples: Sample[] };
  /** How many ms late the game woke the loop's last sleep: game lag. */
  sleptLate: number;
  startedAt: number;
  /** Groups launched so far. It also numbers new group ids, keeping them unique. */
  launched: number;
  launchFailures: number;
  /** What the last launch did, for the status window. */
  lastLaunch: string;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const settings = readSettings(ns);

  const workers = loadWorkers(ns);
  if (!workers) return;
  requireFormulas(ns);
  refuseSecondCopy(ns);

  const state = newState(settings, workers, hackingMoney(ns));
  refreshNetwork(ns, state);
  findLeftoverWorkers(ns, state);

  while (true) {
    const now = Date.now();
    if (now >= state.nextNetworkRefresh) {
      refreshNetwork(ns, state);
      releaseLeftoverTargets(ns, state);
    }

    state.inFlight = dropEndedWorkers(ns, state.inFlight, now);
    endBackoffs(state.targets, now);
    closeFinishedGroups(state.targets, state.inFlight);
    state.runners = readRunners(ns, state);
    readTargets(ns, state, now);
    launchWhatFits(ns, state);

    trackProgress(ns, state);
    renderStatus(ns, state);
    await sleepUntilDue(ns, state);
  }
}

// --- Startup and the network --------------------------------------------------

/** The flags: only --reserve, the GB kept free on home. */
function readSettings(ns: NS): Settings {
  const flags = ns.flags([["reserve", DEFAULT_HOME_RESERVE_GB]]);
  return { homeReserve: Math.max(0, Number(flags.reserve) || 0) };
}

/** Ends the script unless Formulas.exe, which prices every batch, is on home. */
function requireFormulas(ns: NS): void {
  if (ns.fileExists("Formulas.exe", "home")) return;
  fail(
    ns,
    `ERROR: ${ns.getScriptName()} prices its batches with Formulas.exe, ` +
      "which isn't on home.",
  );
}

/** Ends the script if another copy of it is running, and leaves that copy alone. */
function refuseSecondCopy(ns: NS): void {
  const otherPid = otherCopyPid(ns);
  if (otherPid === null) return;
  fail(
    ns,
    `ERROR: ${ns.getScriptName()} is already running (pid ${otherPid}). ` +
      "Stop it first; this copy won't kill it.",
  );
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}

/** The PID of another copy of this script on home, if one is running. */
export function otherCopyPid(ns: NS): number | null {
  const self = ns.getScriptName();
  const other = ns
    .ps("home")
    .find((process) => process.filename === self && process.pid !== ns.pid);
  return other?.pid ?? null;
}

/** The state before the first network refresh. */
function newState(
  settings: Settings,
  workers: Workers,
  moneyAtStart: number,
): State {
  return {
    settings,
    workers,
    hackFraction: 0,
    hosts: ["home"],
    deployedHosts: new Set(),
    workerHosts: new Set(["home"]),
    capacityRam: 0,
    runners: [],
    targets: new Map(),
    inFlight: [],
    leftoverWorkers: [],
    nextNetworkRefresh: 0,
    plan: { fed: 0, income: 0 },
    progress: { moneyAtStart, samples: [] },
    sleptLate: 0,
    startedAt: Date.now(),
    launched: 0,
    launchFailures: 0,
    lastLaunch: "none yet",
  };
}

/** Roots and deploys to anything new, re-measures RAM, and re-picks targets. */
function refreshNetwork(ns: NS, state: State): void {
  state.hosts = scanNetwork(ns);
  rootAvailableServers(ns, state.hosts);
  deployWorkers(ns, state.hosts, state.deployedHosts);

  const capacity = measureCapacity(ns, state.hosts, state.settings.homeReserve);
  state.workerHosts = capacity.workerHosts;
  state.capacityRam = capacity.ram;
  state.nextNetworkRefresh = Date.now() + NETWORK_REFRESH_MS;
  // The picker checks free RAM, which nothing has read yet at startup.
  state.runners = readRunners(ns, state);
  pickTargets(ns, state);
}

/**
 * The rooted servers with the worker files, and their total RAM less the home
 * reserve and other scripts. RAM our workers hold still counts: it comes back.
 */
export function measureCapacity(
  ns: NS,
  hosts: string[],
  homeReserve: number,
): { workerHosts: Set<string>; ram: number } {
  const workerHosts = new Set<string>();
  let ram = 0;

  for (const host of hosts) {
    if (!ns.hasRootAccess(host) || ns.getServerMaxRam(host) <= 0) continue;
    if (host !== "home" && !hasWorkerFiles(ns, host)) continue;

    workerHosts.add(host);
    const reserve = host === "home" ? homeReserve : 0;
    ram += Math.max(
      0,
      ns.getServerMaxRam(host) - reserve - otherScriptsRam(ns, host),
    );
  }
  return { workerHosts, ram };
}

/**
 * Picks the hack fraction whose batches would earn the most with this
 * network's RAM. Then tracks the main targets that plan keeps batching,
 * PREP_TARGETS backups to prep next, and, while over half the RAM sits idle,
 * a few quick earners, and gives every tracked target its role.
 */
function pickTargets(ns: NS, state: State): void {
  const plan = choosePlan(priceFractions(ns, state), state.hackFraction);
  state.hackFraction = plan.fraction;
  state.plan = { fed: plan.fed, income: plan.income };

  const kept = targetsToKeep(plan);
  // Quick earners only use RAM that sits idle, as it does after a start. Kept
  // on once RAM is busy, they would take it from the main targets for good.
  const freeRam = fromUnits(totalUnits(state.runners));
  const quick = freeRam > state.capacityRam / 2 ? quickEarners(plan, kept) : [];

  for (const host of [...kept, ...quick]) {
    if (!state.targets.has(host)) state.targets.set(host, newTarget(host));
  }
  assignRoles(state, plan, kept, quick);
}

/** Each hack fraction's plan, with every money target priced as if prepped. */
function priceFractions(ns: NS, state: State): FractionPlan[] {
  const hosts = state.hosts.filter((host) => isMoneyTarget(ns, host));
  const ram = state.capacityRam;
  return HACK_FRACTIONS.map((fraction) => {
    const sizing = batchSizing(fraction);
    const priced: PricedTarget[] = [];
    for (const host of hosts) {
      const batch = buildPreparedBatch(ns, host, state.workers, sizing, ram);
      if (batch) priced.push({ host, batch });
    }
    return planFraction(fraction, priced, ram);
  });
}

/**
 * Gives every tracked target its role, and drops a retiring one once nothing
 * of it is in flight. Backups batch only to stand in for a main target that
 * is prepping: while every main target is up, a backup's batches would hold
 * RAM the main ones need, for one of its (often long) weaken times.
 */
function assignRoles(
  state: State,
  plan: FractionPlan,
  kept: string[],
  quick: string[],
): void {
  const fed = plan.ranked.slice(0, plan.fed).map(({ host }) => host);
  const mainPrepping = fed.some((host) => isPrepping(state.targets.get(host)));
  const mainHosts = mainPrepping ? kept : fed;

  for (const [host, target] of state.targets) {
    const busy =
      target.activeGroupId !== null || hasWorkersInFlight(state.inFlight, host);
    target.role = roleOf(host, mainHosts, kept, quick);
    if (target.role === "retiring" && !busy) state.targets.delete(host);
  }
}

/** A host's role, from the main targets, everything kept, and the quick earners. */
function roleOf(
  host: string,
  mainHosts: string[],
  kept: string[],
  quick: string[],
): Role {
  if (quick.includes(host)) return "quick";
  if (mainHosts.includes(host)) return "main";
  if (kept.includes(host)) return "backup";
  return "retiring";
}

/** Whether a target needs or is getting prep before it can batch. */
function isPrepping(target: Target | undefined): boolean {
  if (!target) return false;
  return target.phase === "PREP_READY" || target.phase === "PREP_IN_FLIGHT";
}

/**
 * What batches stealing `fraction` would earn with `ram`: best $/GB-s first,
 * each target batching flat out (one batch every four gaps) until the RAM
 * runs out.
 */
export function planFraction(
  fraction: number,
  priced: PricedTarget[],
  ram: number,
): FractionPlan {
  const ranked = [...priced].sort(
    (a, b) =>
      moneyPerGbSecond(b.batch) - moneyPerGbSecond(a.batch) ||
      compareText(a.host, b.host),
  );
  const cycleMs = 4 * LANDING_GAP_MS;
  let free = ram;
  let income = 0;
  let fed = 0;

  for (const { batch } of ranked) {
    if (free <= 0) break;
    // Flat out, a target holds one batch's RAM per cycle of the batch's hold.
    const flatOutRam = (batch.ramNeeded * batchHoldMs(batch)) / cycleMs;
    const share = Math.min(1, free / flatOutRam);
    income += ((batch.expectedMoney * MS_PER_SECOND) / cycleMs) * share;
    free -= flatOutRam * share;
    fed++;
  }
  return { fraction, ranked, fed, income };
}

/**
 * The plan that earns the most, unless the current fraction's plan is within
 * SWITCH_MARGIN of it, so near-ties don't flip back and forth.
 */
export function choosePlan(
  plans: FractionPlan[],
  currentFraction: number,
): FractionPlan {
  const best = plans.reduce((a, b) => (b.income > a.income ? b : a));
  const current = plans.find((plan) => plan.fraction === currentFraction);
  if (current && best.income <= current.income * SWITCH_MARGIN) return current;
  return best;
}

/** The targets a plan keeps batching, then the next PREP_TARGETS to prep. */
export function targetsToKeep(plan: FractionPlan): string[] {
  const ranked = plan.ranked.map(({ host }) => host);
  return ranked.slice(0, plan.fed + PREP_TARGETS);
}

/**
 * Up to QUICK_TARGETS more targets that pay back quickly: a weaken at most
 * QUICK_WEAKEN_SHARE of the best target's, best $/GB-s first. They rank below
 * the main targets, so they only get RAM those can't use yet, and they earn
 * while the main targets fill up after a start.
 */
export function quickEarners(plan: FractionPlan, kept: string[]): string[] {
  const best = plan.ranked[0];
  if (!best) return [];
  const limit = best.batch.weakenTime * QUICK_WEAKEN_SHARE;
  return plan.ranked
    .filter(
      ({ host, batch }) => !kept.includes(host) && batch.weakenTime <= limit,
    )
    .slice(0, QUICK_TARGETS)
    .map(({ host }) => host);
}

/**
 * Finds workers a previous copy of this script left running. Their targets
 * get nothing new until those workers end, and are then read fresh.
 */
export function findLeftoverWorkers(ns: NS, state: State): void {
  for (const host of state.hosts) {
    if (!ns.hasRootAccess(host)) continue;

    for (const process of ns.ps(host)) {
      if (!WORKER_FILE_LIST.includes(process.filename)) continue;
      const { target, batchId } = fromWorkerArgs(process.args);
      if (!batchId.startsWith(`${GROUP_ID_PREFIX}-`)) continue;

      state.leftoverWorkers.push({ host, pid: process.pid, target });
      if (!target) continue;

      const record = state.targets.get(target) ?? newTarget(target);
      record.activeGroupId = LEFTOVER_GROUP_ID;
      state.targets.set(target, record);
    }
  }
}

// --- Each loop ----------------------------------------------------------------

/** The launched workers still running. A worker is only checked once it is due. */
export function dropEndedWorkers(
  ns: NS,
  inFlight: Receipt[],
  now: number,
): Receipt[] {
  return inFlight.filter(
    (receipt) =>
      now < receipt.endsAt || ns.isRunning(receipt.pid, receipt.host),
  );
}

/**
 * Forgets a previous copy's workers once they have ended, and sends each
 * target with none left for a fresh reading. Done on each network refresh,
 * not every loop: after a restart there can be thousands of them, and their
 * targets have been waiting a weaken time already.
 */
export function releaseLeftoverTargets(ns: NS, state: State): void {
  state.leftoverWorkers = state.leftoverWorkers.filter((worker) =>
    ns.isRunning(worker.pid, worker.host),
  );
  const held = new Set(state.leftoverWorkers.map((worker) => worker.target));
  for (const target of state.targets.values()) {
    if (target.activeGroupId !== LEFTOVER_GROUP_ID) continue;
    if (held.has(target.host)) continue;
    target.activeGroupId = null;
    target.phase = "NEEDS_READING";
  }
}

/** Sends each target whose backoff is over back for a fresh reading. */
export function endBackoffs(targets: Map<string, Target>, now: number): void {
  for (const target of targets.values()) {
    if (target.phase !== "BACKOFF" || now < target.backoffUntil) continue;
    target.phase = "NEEDS_READING";
  }
}

/**
 * Sends a target back for a fresh reading once every worker of its group has
 * ended: a worker's effect has landed by the time its process ends, so the
 * reading can be taken straight away.
 */
export function closeFinishedGroups(
  targets: Map<string, Target>,
  inFlight: Receipt[],
): void {
  for (const target of targets.values()) {
    const groupId = target.activeGroupId;
    if (groupId === null || groupId === LEFTOVER_GROUP_ID) continue;
    if (inFlight.some((receipt) => receipt.groupId === groupId)) continue;

    target.phase = "NEEDS_READING";
    target.activeGroupId = null;
  }
}

/** Free RAM on every server with the worker files, less the home reserve. */
export function readRunners(ns: NS, state: State): Runner[] {
  return [...state.workerHosts].map((host) => {
    const reserve = host === "home" ? state.settings.homeReserve : 0;
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
    return { host, units: toUnits(Math.max(0, free)) };
  });
}

/**
 * Reads every target that could take a group this loop, so nothing is ever
 * planned from an older reading: each hacking level shortens hack, grow and
 * weaken, and a plan timed before a level-up lands out of order.
 */
export function readTargets(ns: NS, state: State, now: number): void {
  for (const target of state.targets.values()) {
    if (target.phase === "BATCH_IN_FLIGHT") {
      readRunningChain(ns, state, target);
      continue;
    }
    if (target.activeGroupId !== null) continue;
    if (hasWorkersInFlight(state.inFlight, target.host)) continue;
    if (target.phase === "BACKOFF") continue;

    const reading = readServer(ns, target.host);
    const economics = reading
      ? computeEconomics(ns, state, target.host, reading)
      : null;
    recordReading(target, reading, economics, now);
  }
}

/**
 * Reads a target whose batches are landing. While it reads prepped, between
 * one batch's last landing and the next one's hack, its batch is rebuilt
 * from this reading for the next append.
 */
function readRunningChain(ns: NS, state: State, target: Target): void {
  const reading = readServer(ns, target.host);
  target.reading = reading;
  if (!isPrepped(reading)) return;
  target.economics = computeEconomics(ns, state, target.host, reading);
}

/** A server's money, security and timings; null if it can't be hacked for money now. */
function readServer(ns: NS, host: string): Reading | null {
  if (!isMoneyTarget(ns, host)) return null;

  const server = ns.getServer(host);
  return {
    money: server.moneyAvailable ?? 0,
    maxMoney: server.moneyMax ?? 0,
    security: server.hackDifficulty ?? 100,
    minSecurity: server.minDifficulty ?? 100,
    growTime: ns.getGrowTime(host),
    weakenTime: ns.getWeakenTime(host),
  };
}

/** Prices a target's batch and its prep from a fresh reading. */
export function computeEconomics(
  ns: NS,
  state: State,
  host: string,
  reading: Reading,
): Economics {
  const rate = levelingRate(state.progress.samples);
  const sizing = batchSizing(state.hackFraction, rate);
  const batch = buildPreparedBatch(
    ns,
    host,
    state.workers,
    sizing,
    state.capacityRam,
  );
  const weakenPerThread = ns.weakenAnalyze(1, 1);

  // No hostname on growthAnalyzeSecurity: passing one caps the answer against
  // the target's current money, which is wrong for growth planned after a hack.
  const growSecurityPerThread = ns.growthAnalyzeSecurity(1, undefined, 1);

  const { money, maxMoney, security, minSecurity } = reading;
  const moneyShort = money < maxMoney * MONEY_READY_RATIO;
  const excess = security - minSecurity;

  return {
    batch,
    moneyPerGbSecond: batch ? moneyPerGbSecond(batch) : 0,
    prep: {
      growThreads: moneyShort ? growThreadsToRefill(ns, host) : 0,
      excessWeakenThreads:
        excess > SECURITY_TOLERANCE ? Math.ceil(excess / weakenPerThread) : 0,
      growSecurityPerThread,
      weakenPerThread,
      growTime: reading.growTime,
      weakenTime: reading.weakenTime,
    },
  };
}

/** Grow threads to refill a target from its money and security now: at least one. */
function growThreadsToRefill(ns: NS, host: string): number {
  const server = ns.getServer(host);
  const multiplier =
    (server.moneyMax ?? 0) / Math.max(1, server.moneyAvailable ?? 0);
  const player = ns.getPlayer();
  const threads = growThreadsFor(
    ns,
    server,
    player,
    multiplier,
    GROW_SAFETY_MARGIN,
  );
  return Number.isFinite(threads) && threads >= 1 ? threads : 1;
}

/**
 * Launches what decide() picks, again and again while groups fit, up to
 * LAUNCHES_PER_LOOP groups or LAUNCH_BUDGET_MS.
 */
function launchWhatFits(ns: NS, state: State): void {
  const startedAt = Date.now();
  let launches = 0;

  while (true) {
    const now = Date.now();
    const decision = decide([...state.targets.values()], state.inFlight, {
      runners: state.runners,
      workers: state.workers,
      now,
      serial: state.launched,
    });
    if (!launchDecision(ns, state, decision, now)) return;

    launches++;
    state.runners = readRunners(ns, state);
    const elapsed = Date.now() - startedAt;
    if (launches >= LAUNCHES_PER_LOOP || elapsed >= LAUNCH_BUDGET_MS) return;
  }
}

/** Launches the decision's group, if it has one. False if nothing launched. */
export function launchDecision(
  ns: NS,
  state: State,
  decision: Decision,
  now: number,
): boolean {
  if (decision.kind === "idle") return false;
  const { target, group, fragments } = decision;

  const launch = launchGroup(ns, group, fragments);
  if (!launch.ok) {
    state.launchFailures++;
    state.lastLaunch = `FAILED ${target.host}: ${launch.reason}`;
    // A failed append is offered again next loop; the chain keeps landing.
    if (!group.continuation) backOff(target, now);
    return false;
  }

  state.inFlight.push(...launch.receipts);
  markLaunched(target, group);
  state.launched++;
  state.lastLaunch = `${describeGroup(group)} on ${launch.receipts.length} pid(s)`;
  return true;
}

/**
 * Launches every fragment of a group in delay order, or nothing at all: if
 * any exec fails, everything already started is killed.
 */
export function launchGroup(
  ns: NS,
  group: Group,
  fragments: Fragment[],
): Launch {
  // Workers count their delays from this moment, so the time spent planning
  // since the group's plannedAt has come out of the launch lead.
  const launchedAt = Date.now();
  const skew = launchedAt - group.plannedAt;
  if (LAUNCH_LEAD_MS - skew < LAUNCH_SAFETY_MS) {
    return {
      ok: false,
      reason: `planning consumed ${skew}ms of the ${LAUNCH_LEAD_MS}ms lead`,
    };
  }

  const receipts: Receipt[] = [];
  const ordered = [...fragments].sort((a, b) => a.job.delay - b.job.delay);
  for (const { job, host, threads, units } of ordered) {
    const args = toWorkerArgs({
      target: group.target,
      delay: job.delay,
      plannedAt: launchedAt,
      batchId: job.batchId,
      label: job.label,
    });
    const options = { threads, temporary: true };
    const pid = ns.exec(job.worker.file, host, options, ...args);
    if (pid === 0) {
      for (const launched of receipts) ns.kill(launched.pid);
      return { ok: false, reason: `exec failed on ${host} for ${job.id}` };
    }
    receipts.push({
      groupId: group.id,
      target: group.target,
      host,
      pid,
      units,
      endsAt: launchedAt + job.delay + job.duration,
    });
  }

  return { ok: true, receipts };
}

/**
 * Sleeps until the next thing that could need action, and notes how late the
 * game woke it: timers firing late are game lag, and they make landings late.
 */
async function sleepUntilDue(ns: NS, state: State): Promise<void> {
  const delay = nextWakeDelay(state, Date.now());
  const due = Date.now() + delay;
  await ns.sleep(delay);
  state.sleptLate = Math.max(0, Date.now() - due);
}

/**
 * How long to sleep: until a worker's expected end, a backoff ending, an
 * append window opening, or the network refresh. Never less than
 * MIN_SLEEP_MS or more than MAX_SLEEP_MS.
 */
function nextWakeDelay(state: State, now: number): number {
  let wakeAt = Math.min(now + MAX_SLEEP_MS, state.nextNetworkRefresh);

  for (const receipt of state.inFlight) {
    wakeAt = Math.min(wakeAt, receipt.endsAt);
  }
  for (const target of state.targets.values()) {
    if (target.phase === "BACKOFF") {
      wakeAt = Math.min(wakeAt, target.backoffUntil);
    }
    const append = appendWindow(target, state.inFlight);
    if (append && append.launchAt > now) {
      wakeAt = Math.min(wakeAt, append.launchAt);
    }
  }

  return Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, wakeAt - now));
}

// --- Deciding what to launch --------------------------------------------------

/**
 * Picks the one group to launch next: the best complete wave that fits, or
 * else the best prep that fits without holding RAM a waiting batch needs.
 */
export function decide(
  targets: Target[],
  inFlight: Receipt[],
  ctx: PlanContext,
): Decision {
  const pass = nextWave(targets, inFlight, ctx);
  if (pass.found) return pass.decision;

  const prepCtx = { ...ctx, runners: pass.runnersLeft };
  return nextPrep(targets, inFlight, prepCtx, pass.waitingBatchUnits);
}

/**
 * The best complete wave that fits. A running chain whose next wave can't go
 * yet, because its window hasn't opened or its target is mid-landing, will
 * go within one wave. So it holds the RAM that wave needs, and only work
 * that fits around it launches: a worse target would hold that RAM for a
 * whole weaken time.
 */
function nextWave(
  targets: Target[],
  inFlight: Receipt[],
  ctx: PlanContext,
): WavePass {
  let runners = ctx.runners;
  let waitingBatchUnits: number | null = null;

  for (const { target, append } of waveCandidates(targets, inFlight)) {
    const batch = target.economics?.batch;
    if (!batch) continue;

    const wave = planWave(target, batch, append, { ...ctx, runners });
    const notYet =
      append !== null &&
      (ctx.now < append.launchAt || !isPrepped(target.reading));
    if (wave.ok && notYet) {
      runners = withoutFragments(runners, wave.fragments);
      continue;
    }
    if (wave.ok) {
      const { group, fragments } = wave;
      return {
        found: true,
        decision: { kind: "batch", target, group, fragments },
      };
    }
    waitingBatchUnits ??= wave.requiredUnits;
  }
  return { found: false, runnersLeft: runners, waitingBatchUnits };
}

/** The running chains and ready targets that may take a wave, best $/GB-s first. */
function waveCandidates(
  targets: Target[],
  inFlight: Receipt[],
): WaveCandidate[] {
  const candidates: WaveCandidate[] = [];
  for (const target of targets) {
    if (target.role === "retiring" || target.role === "backup") continue;
    const append = appendWindow(target, inFlight);
    if (append) {
      candidates.push({ target, append });
      continue;
    }
    if (target.phase !== "BATCH_READY" || !isIdle(target, inFlight)) continue;
    if (moneyPerGbSecondOf(target) > 0)
      candidates.push({ target, append: null });
  }
  return candidates.sort((a, b) => bestFirst(a.target, b.target));
}

/** The best prep that fits without holding RAM a waiting batch needs; else idle. */
function nextPrep(
  targets: Target[],
  inFlight: Receipt[],
  ctx: PlanContext,
  waitingBatchUnits: number | null,
): Decision {
  const freeUnits = totalUnits(ctx.runners);
  const prepTargets = targets
    .filter((target) => target.phase === "PREP_READY")
    .filter((target) => target.role !== "retiring")
    .filter((target) => isIdle(target, inFlight))
    .sort(byPrepOrder);
  for (const target of prepTargets) {
    const prep = planPrep(target, ctx);
    if (!prep.ok) continue;
    const { group, fragments } = prep;
    if (!leavesBatchWindow(group, waitingBatchUnits, inFlight, freeUnits)) {
      continue;
    }
    return { kind: "prep", target, group, fragments };
  }

  return { kind: "idle" };
}

/** Whether a target has nothing in flight and no group it is waiting on. */
export function isIdle(target: Target, inFlight: Receipt[]): boolean {
  return (
    target.activeGroupId === null && !hasWorkersInFlight(inFlight, target.host)
  );
}

/**
 * When the next wave can launch behind a target's running batch chain, timed
 * so its first hack lands one gap after the chain's last landing. Null when
 * nothing of the chain is left in flight.
 */
export function appendWindow(
  target: Target,
  inFlight: Receipt[],
): AppendWindow | null {
  const batch = target.economics?.batch;
  const groupId = target.activeGroupId;
  if (target.phase !== "BATCH_IN_FLIGHT" || !batch) return null;
  if (groupId === null || groupId === LEFTOVER_GROUP_ID) return null;

  // One pass, no spread: a chain can have thousands of workers in flight.
  let lastEndAt = -Infinity;
  for (const receipt of inFlight) {
    if (receipt.groupId !== groupId || receipt.target !== target.host) continue;
    lastEndAt = Math.max(lastEndAt, receipt.endsAt);
  }
  if (lastEndAt === -Infinity) return null;

  return {
    lastEndAt,
    launchAt: lastEndAt + LANDING_GAP_MS - LAUNCH_LEAD_MS - batch.weakenTime,
  };
}

/** Prep queue order: best $/GB-s first, unpriced targets last, then longest waiting. */
function byPrepOrder(a: Target, b: Target): number {
  return (
    moneyPerGbSecondOf(b) - moneyPerGbSecondOf(a) ||
    a.waitingSince - b.waitingSince ||
    compareText(a.host, b.host)
  );
}

/**
 * Whether a prep group leaves room for the batch waiting on RAM. It doesn't
 * when in-flight work will free enough for that batch at a known time and the
 * prep would still be holding too much RAM then.
 */
export function leavesBatchWindow(
  prep: Group,
  waitingBatchUnits: number | null,
  inFlight: Receipt[],
  freeUnits: number,
): boolean {
  if (waitingBatchUnits === null) return true;

  const shortfall = waitingBatchUnits - freeUnits;
  if (shortfall <= 0) return true;

  const windowStart = earliestReleaseTime(inFlight, shortfall);
  if (windowStart === null) return true;

  // Prep that has given its RAM back before the window can't delay anything.
  if (prep.lastEndAt <= windowStart) return true;

  const releasedByThen = totalUnits(
    inFlight.filter((receipt) => receipt.endsAt <= windowStart),
  );
  const freeAtWindow = freeUnits + releasedByThen - requiredUnits(prep.jobs);
  return freeAtWindow >= waitingBatchUnits;
}

/** When enough in-flight RAM will be back to cover `units`, or null if never. */
export function earliestReleaseTime(
  inFlight: Receipt[],
  units: number,
): number | null {
  const byEnd = [...inFlight].sort((a, b) => a.endsAt - b.endsAt);

  let released = 0;
  for (const receipt of byEnd) {
    released += receipt.units;
    if (released >= units) return receipt.endsAt;
  }
  return null;
}

// --- Planning groups ----------------------------------------------------------

/**
 * The largest wave of `batch` that fits. With an append window it continues
 * the target's running chain: same group id, the next batch ids, and a first
 * landing no earlier than one gap after the chain's last.
 */
export function planWave(
  target: Target,
  batch: Batch,
  append: AppendWindow | null,
  ctx: PlanContext,
): Placement {
  const groupId =
    append && target.activeGroupId
      ? target.activeGroupId
      : `${GROUP_ID_PREFIX}-b${ctx.serial}-${target.host}`;
  const firstIndex = append ? target.scheduledBatchCount : 0;
  const landingOffset = append
    ? Math.max(
        0,
        append.lastEndAt +
          LANDING_GAP_MS -
          ctx.now -
          LAUNCH_LEAD_MS -
          batch.weakenTime,
      )
    : 0;

  return largestThatFits(ctx.runners, MAX_BATCHES, (count) => {
    const jobs: Job[] = [];
    for (let i = 0; i < count; i++) {
      const batchId = `${groupId}-${firstIndex + i}`;
      const offset = landingOffset + i * 4 * LANDING_GAP_MS;
      jobs.push(...batchJobs(batchId, batch, ctx.workers, offset));
    }
    return newGroup({
      id: groupId,
      purpose: "batch",
      target: target.host,
      plannedAt: ctx.now,
      jobs,
      batchCount: count,
      continuation: append !== null,
    });
  });
}

/**
 * The largest prep that fits: grow, if money is short, with weaken for its
 * security and for any already over minimum. If no grow fits beside all that
 * weaken, just the weaken. Unlike a wave, prep may shrink to partial progress.
 */
export function planPrep(target: Target, ctx: PlanContext): Placement {
  const groupId = `${GROUP_ID_PREFIX}-p${ctx.serial}-${target.host}`;
  const noPlan: Placement = { ok: false, requiredUnits: 0 };
  if (!target.economics) return noPlan;
  const { prep } = target.economics;

  if (prep.growThreads >= 1) {
    const withGrow = planGrowPrep(target.host, prep, groupId, ctx);
    if (withGrow.ok || prep.excessWeakenThreads < 1) return withGrow;
  }
  if (prep.excessWeakenThreads < 1) return noPlan;

  return largestThatFits(ctx.runners, prep.excessWeakenThreads, (threads) => {
    const weaken = makeJob({
      batchId: `${groupId}-0`,
      label: "PREP-W",
      worker: ctx.workers.weaken,
      threads,
      delay: LAUNCH_LEAD_MS,
      duration: prep.weakenTime,
    });
    return newGroup({
      id: groupId,
      purpose: "prep",
      target: target.host,
      plannedAt: ctx.now,
      jobs: [weaken],
      batchCount: 0,
      continuation: false,
    });
  });
}

/**
 * The largest grow that fits together with the weaken that cancels its
 * security, plus the weaken for security already over minimum.
 */
function planGrowPrep(
  host: string,
  prep: Prep,
  groupId: string,
  ctx: PlanContext,
): Placement {
  const batchId = `${groupId}-0`;
  const { grow, weaken } = ctx.workers;
  const { growTime: g, weakenTime: w } = prep;
  const max = Math.max(1, Math.floor(prep.growThreads));

  return largestThatFits(ctx.runners, max, (growThreads) => {
    const growSecurity = growThreads * prep.growSecurityPerThread;
    const weakenPerThread = Math.max(
      MIN_WEAKEN_PER_THREAD,
      prep.weakenPerThread,
    );
    const weakenThreads =
      prep.excessWeakenThreads +
      Math.max(1, Math.ceil(growSecurity / weakenPerThread));
    const lead = LAUNCH_LEAD_MS;
    const jobs = [
      makeJob({
        batchId,
        label: "PREP-G",
        worker: grow,
        threads: growThreads,
        delay: lead + Math.max(0, w - g),
        duration: g,
      }),
      makeJob({
        batchId,
        label: "PREP-W",
        worker: weaken,
        threads: weakenThreads,
        delay: lead + LANDING_GAP_MS,
        duration: w,
      }),
    ];
    return newGroup({
      id: groupId,
      purpose: "prep",
      target: host,
      plannedAt: ctx.now,
      jobs,
      batchCount: 0,
      continuation: false,
    });
  });
}

/**
 * The largest size, from 1 to `max`, whose group fits: `max` if it does,
 * else a binary search below it. Waves shrink by whole batches and prep by
 * whole grow/weaken pairs, so whatever fits is complete. When nothing fits,
 * says how much a size-1 group needs.
 */
function largestThatFits(
  runners: Runner[],
  max: number,
  groupOfSize: (size: number) => Group,
): Placement {
  // Every waiting chain's next wave is placed each loop to hold its RAM, and
  // with RAM to spare a whole wave fits: one placement instead of five.
  const whole = place(runners, groupOfSize(max));
  if (whole.ok) return whole;

  let low = 1;
  let high = max - 1;
  let best: Placement | null = null;

  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const placement = place(runners, groupOfSize(size));
    if (placement.ok) {
      best = placement;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  return best ?? place(runners, groupOfSize(1));
}

/**
 * Places every thread of every job, or nothing. Jobs with the most RAM per
 * thread and most threads go first; servers with the most free RAM fill
 * first, home last so its RAM stays free for anything run by hand. A job may
 * be split across servers, but never a thread.
 */
export function place(runners: Runner[], group: Group): Placement {
  const { jobs } = group;
  const shortage: Placement = { ok: false, requiredUnits: requiredUnits(jobs) };
  const invalid = jobs.some(
    ({ threads, worker }) =>
      !Number.isFinite(threads) ||
      threads < 1 ||
      !Number.isFinite(worker.ram) ||
      worker.ram <= 0,
  );
  if (invalid) return shortage;

  const hosts = runners
    .map((runner) => ({ host: runner.host, units: runner.units }))
    .sort(byPlacementOrder);
  const fragments: Fragment[] = [];

  for (const job of [...jobs].sort(byJobOrder)) {
    const unitCost = toUnits(job.worker.ram);
    let remaining = job.threads;

    for (const entry of hosts) {
      const threads = Math.min(remaining, Math.floor(entry.units / unitCost));
      if (threads < 1) continue;

      const units = threads * unitCost;
      fragments.push({ job, host: entry.host, threads, units });
      entry.units -= units;
      remaining -= threads;
      if (remaining === 0) break;
    }
    if (remaining > 0) return shortage;
    hosts.sort(byPlacementOrder);
  }

  return { ok: true, group, fragments };
}

/** The runners' free RAM once these fragments are placed on them. */
function withoutFragments(runners: Runner[], fragments: Fragment[]): Runner[] {
  return runners.map((runner) => {
    const placed = totalUnits(
      fragments.filter((fragment) => fragment.host === runner.host),
    );
    return { ...runner, units: runner.units - placed };
  });
}

/** Most RAM per thread first, then most threads, earliest delay, then id. */
function byJobOrder(a: Job, b: Job): number {
  return (
    b.worker.ram - a.worker.ram ||
    b.threads - a.threads ||
    a.delay - b.delay ||
    compareText(a.id, b.id)
  );
}

/** Home last; otherwise most free RAM first, then by name. */
function byPlacementOrder(a: Runner, b: Runner): number {
  if (a.host === "home" && b.host !== "home") return 1;
  if (b.host === "home" && a.host !== "home") return -1;
  return b.units - a.units || compareText(a.host, b.host);
}

/**
 * One batch's H, W1, G and W2, delayed so they land LANDING_GAP_MS apart in
 * that order, `offset` ms after the earliest the hack could land.
 */
export function batchJobs(
  batchId: string,
  batch: Batch,
  workers: Workers,
  offset: number,
): Job[] {
  const { hackTime: h, growTime: g, weakenTime: w } = batch;
  const lead = LAUNCH_LEAD_MS;
  const gap = LANDING_GAP_MS;

  return [
    makeJob({
      batchId,
      label: "H",
      worker: workers.hack,
      threads: batch.hackThreads,
      delay: lead + Math.max(0, w - h) + offset,
      duration: h,
    }),
    makeJob({
      batchId,
      label: "W1",
      worker: workers.weaken,
      threads: batch.weakenHackThreads,
      delay: lead + gap + offset,
      duration: w,
    }),
    makeJob({
      batchId,
      label: "G",
      worker: workers.grow,
      threads: batch.growThreads,
      delay: lead + Math.max(0, w - g) + 2 * gap + offset,
      duration: g,
    }),
    makeJob({
      batchId,
      label: "W2",
      worker: workers.weaken,
      threads: batch.weakenGrowThreads,
      delay: lead + 3 * gap + offset,
      duration: w,
    }),
  ];
}

/** A job, with its id; threads and delay are whole numbers, and no time is negative. */
export function makeJob({
  batchId,
  label,
  worker,
  threads,
  delay,
  duration,
}: Omit<Job, "id">): Job {
  return {
    id: `${batchId}-${label}`,
    batchId,
    label,
    worker,
    threads: Math.max(0, Math.floor(threads)),
    delay: Math.max(0, Math.floor(delay)),
    duration: Math.max(0, duration),
  };
}

/** A group, with when its last job ends worked out from its jobs. */
export function newGroup(group: Omit<Group, "lastEndAt">): Group {
  const lastEnd = Math.max(
    0,
    ...group.jobs.map((job) => job.delay + job.duration),
  );
  return { ...group, lastEndAt: group.plannedAt + lastEnd };
}

// --- Target state ---------------------------------------------------------------

/** A newly tracked target, waiting for its first reading. */
export function newTarget(host: string): Target {
  return {
    host,
    phase: "NEEDS_READING",
    role: "main",
    reading: null,
    economics: null,
    activeGroupId: null,
    backoffUntil: 0,
    waitingSince: 0,
    scheduledBatchCount: 0,
    paysAt: 0,
    hacks: [],
  };
}

/** What a reading says the target needs next. */
export function classify(reading: Reading | null): Phase {
  if (!reading) return "UNAVAILABLE";
  const securityHigh =
    reading.security > reading.minSecurity + SECURITY_TOLERANCE;
  const moneyShort = reading.money < reading.maxMoney * MONEY_READY_RATIO;
  return securityHigh || moneyShort ? "PREP_READY" : "BATCH_READY";
}

/** Whether a reading is at minimum security and maximum money. */
function isPrepped(reading: Reading | null): reading is Reading {
  return classify(reading) === "BATCH_READY";
}

/** Stores a fresh reading and moves the target to the phase it calls for. */
export function recordReading(
  target: Target,
  reading: Reading | null,
  economics: Economics | null,
  now: number,
): void {
  const phase = classify(reading);
  // A target still waiting for prep keeps its place in the prep queue.
  const stillWaiting = phase === "PREP_READY" && target.phase === "PREP_READY";
  if (!stillWaiting) target.waitingSince = now;
  target.phase = phase;
  target.reading = reading;
  target.economics = economics;
  target.activeGroupId = null;
  target.scheduledBatchCount = 0;
}

/**
 * Records a launched group on its target. For a wave it also notes when each
 * hack lands and what it should steal, and for a new chain when it pays.
 */
export function markLaunched(target: Target, group: Group): void {
  target.activeGroupId = group.id;
  if (group.purpose !== "batch") {
    target.phase = "PREP_IN_FLIGHT";
    return;
  }
  target.phase = "BATCH_IN_FLIGHT";
  target.scheduledBatchCount += group.batchCount;
  const landings = hackLandings(group);
  if (!group.continuation) target.paysAt = Math.min(...landings);
  const money = target.economics?.batch?.expectedMoney ?? 0;
  for (const landsAt of landings) target.hacks.push({ landsAt, money });
}

/** When each of a wave's hacks lands. */
function hackLandings(group: Group): number[] {
  return group.jobs
    .filter((job) => job.label === "H")
    .map((job) => group.plannedAt + job.delay + job.duration);
}

/** Takes a target out for BACKOFF_MS, after which it is read again. */
export function backOff(target: Target, now: number): void {
  target.phase = "BACKOFF";
  target.activeGroupId = null;
  target.backoffUntil = now + BACKOFF_MS;
}

// --- Small helpers --------------------------------------------------------------

/** A server we can hack for money: not ours, has money, rooted, in level. */
function isMoneyTarget(ns: NS, host: string): boolean {
  if (!ns.serverExists(host) || !ns.hasRootAccess(host)) return false;
  const server = ns.getServer(host);
  if (server.purchasedByPlayer || (server.moneyMax ?? 0) <= 0) return false;
  return (server.requiredHackingSkill ?? Infinity) <= ns.getHackingLevel();
}

/** Whether all three worker files are on the server. */
function hasWorkerFiles(ns: NS, host: string): boolean {
  return WORKER_FILE_LIST.every((file) => ns.fileExists(file, host));
}

/** RAM used on a server by scripts that aren't our workers. */
function otherScriptsRam(ns: NS, host: string): number {
  return ns
    .ps(host)
    .filter((process) => !WORKER_FILE_LIST.includes(process.filename))
    .reduce(
      (sum, process) =>
        sum + process.threads * ns.getScriptRam(process.filename, host),
      0,
    );
}

/**
 * How batches are sized. Given a leveling rate, grow is sized for the level
 * each hack lands with: a level-up between launch and landing makes the hack
 * steal more, and at a high hack fraction grow would fall behind. The picker
 * leaves it out, so targets don't swap places on how fast you level.
 */
function batchSizing(hackFraction: number, levelsPerMs = 0): BatchSizing {
  return {
    hackFraction,
    minimumHackFraction: MIN_HACK_FRACTION,
    growSafetyMargin: GROW_SAFETY_MARGIN,
    levelsPerMs,
  };
}

/**
 * Hacking levels gained per millisecond lately. It divides by the whole
 * window even while that is filling, so a fresh start understates the rate
 * rather than spiking on its first level-up.
 */
export function levelingRate(samples: Array<{ level: number }>): number {
  const last = samples.at(-1);
  if (samples.length < 2 || !last) return 0;
  const gained = last.level - samples[0].level;
  return Math.max(0, gained) / LEVELING_WINDOW_MS;
}

/** How long a batch holds its RAM: from launch to its last landing. */
function batchHoldMs(batch: Batch): number {
  return LAUNCH_LEAD_MS + batch.weakenTime + 3 * LANDING_GAP_MS;
}

/** Expected $ per GB-second of RAM the batch holds. */
function moneyPerGbSecond(batch: Batch): number {
  return (
    batch.expectedMoney /
    ((batch.ramNeeded * batchHoldMs(batch)) / MS_PER_SECOND)
  );
}

/** Expected $ per GB-second of a target's batch; 0 if it has none. */
function moneyPerGbSecondOf(target: Target): number {
  return target.economics?.moneyPerGbSecond ?? 0;
}

/** Best $/GB-s first, then by name. */
function bestFirst(a: Target, b: Target): number {
  return (
    moneyPerGbSecondOf(b) - moneyPerGbSecondOf(a) || compareText(a.host, b.host)
  );
}

/** Whether any launched worker is still working on `host`. */
export function hasWorkersInFlight(inFlight: Receipt[], host: string): boolean {
  return inFlight.some((receipt) => receipt.target === host);
}

/** The RAM, in units, that all of these jobs' threads take. */
export function requiredUnits(jobs: Job[]): number {
  return jobs.reduce(
    (sum, job) => sum + toUnits(job.worker.ram) * job.threads,
    0,
  );
}

/** The units of RAM these runners have free, or these workers or fragments hold. */
function totalUnits(items: Array<{ units: number }>): number {
  return items.reduce((sum, item) => sum + item.units, 0);
}

/** GB as whole units of RAM. */
function toUnits(gb: number): number {
  return Math.round(gb * UNITS_PER_GB);
}

/** Units of RAM as GB. */
function fromUnits(units: number): number {
  return units / UNITS_PER_GB;
}

/** Orders text the same way everywhere, whatever the locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Status window --------------------------------------------------------------

/** Hacking money made since the last augmentation install. */
function hackingMoney(ns: NS): number {
  return ns.getMoneySources().sinceInstall.hacking;
}

/**
 * Samples hacking money, level and lag, keeping LEVELING_WINDOW_MS of
 * samples, and forgets hacks that landed over INCOME_WINDOW_MS ago: the status
 * window shows income and lag from these, and batches are sized for leveling.
 */
function trackProgress(ns: NS, state: State): void {
  const now = Date.now();
  const { samples } = state.progress;
  const level = ns.getHackingLevel();
  const late = state.sleptLate;
  samples.push({ at: now, money: hackingMoney(ns), level, late });
  while (samples.length > 1 && now - samples[0].at > LEVELING_WINDOW_MS) {
    samples.shift();
  }
  for (const target of state.targets.values()) {
    target.hacks = target.hacks.filter(
      (hack) => now - hack.landsAt <= INCOME_WINDOW_MS,
    );
  }
}

/** Redraws the status window. */
function renderStatus(ns: NS, state: State): void {
  ns.clearLog();
  const now = Date.now();
  const lines = [
    headerLine(state, now),
    incomeLine(ns, state, now),
    lagLine(state, now),
    ramLine(state),
    planLine(ns, state),
    `Last launch: ${state.lastLaunch}`,
    ...targetLines(ns, state, now),
  ];
  const leftover = state.leftoverWorkers.length;
  if (leftover > 0) {
    lines.push(`Waiting on ${leftover} worker(s) left by a previous run`);
  }
  // One entry, not one per line: the game keeps only the newest 50 log
  // entries by default, which cut the top off the status once there were
  // many targets.
  ns.print(lines.join("\n"));
}

/** How long the manager has run, and how many launches worked and failed. */
function headerLine(state: State, now: number): string {
  return (
    `=== MULTI-MANAGER === up ${formatDuration(now - state.startedAt)} | ` +
    `${state.launched} launches, ${state.launchFailures} failed`
  );
}

/** Hacking $/s over the last minute and since start, and the level and its climb. */
function incomeLine(ns: NS, state: State, now: number): string {
  const { samples, moneyAtStart } = state.progress;
  const last = samples.at(-1);
  if (!last) return "Hacking: no samples yet";

  const first = recentSamples(state, now)[0] ?? last;
  const lastMinute = perSecond(last.money - first.money, last.at - first.at);
  const sinceStart = perSecond(
    last.money - moneyAtStart,
    now - state.startedAt,
  );
  const levelsPerHour = levelingRate(samples) * MS_PER_HOUR;
  return (
    `Hacking: ${formatIncome(ns, lastMinute)} last minute | ` +
    `${formatIncome(ns, sinceStart)} since start | level ${last.level} ` +
    `(+${levelsPerHour.toFixed(0)}/h)`
  );
}

/** How late the game woke the loop's sleeps over the last minute. */
function lagLine(state: State, now: number): string {
  const recent = recentSamples(state, now);
  const lateTotal = recent.reduce((sum, sample) => sum + sample.late, 0);
  const lateWorst = recent.reduce(
    (worst, sample) => Math.max(worst, sample.late),
    0,
  );
  return (
    `Game lag: ${(lateTotal / Math.max(1, recent.length)).toFixed(0)} ms ` +
    `average, ${lateWorst.toFixed(0)} ms worst, last minute ` +
    `(landings are ${LANDING_GAP_MS} ms apart)`
  );
}

/** The samples of the last INCOME_WINDOW_MS. */
function recentSamples(state: State, now: number): Sample[] {
  return state.progress.samples.filter(
    (sample) => now - sample.at <= INCOME_WINDOW_MS,
  );
}

/** The workers' RAM: how much there is, how much is in use, and the home reserve. */
function ramLine(state: State): string {
  const inUse = fromUnits(totalUnits(state.inFlight));
  const free = fromUnits(totalUnits(state.runners));
  const usedShare = state.capacityRam > 0 ? inUse / state.capacityRam : 0;
  return (
    `RAM: ${formatRam(state.capacityRam)} on ${state.runners.length} servers | ` +
    `${(usedShare * 100).toFixed(0)}% in use | ${formatRam(free)} free | ` +
    `home reserve ${formatRam(state.settings.homeReserve)}`
  );
}

/** The picked plan: the hack fraction, the main targets and full-speed income. */
function planLine(ns: NS, state: State): string {
  return (
    `Plan: batches steal ${(state.hackFraction * 100).toFixed(0)}% | ` +
    `${state.plan.fed} main target(s) | full speed ` +
    formatIncome(ns, state.plan.income)
  );
}

/** A header, then one line per target, most $/s first. */
function targetLines(ns: NS, state: State, now: number): string[] {
  const span = Math.min(INCOME_WINDOW_MS, now - state.startedAt);
  const rows = [...state.targets.values()]
    .map((target) => ({ target, income: recentIncome(target, now, span) }))
    .sort((a, b) => b.income - a.income || bestFirst(a.target, b.target));
  const header = targetRow({
    host: "target",
    earning: "$/s",
    activity: "doing",
    money: "money",
    security: "security",
    ram: "RAM",
    timing: "when",
  });
  return [
    `--- targets (${rows.length}), most $/s first ---`,
    header,
    ...rows.map(({ target, income }) =>
      targetLine(ns, state, target, income, now),
    ),
  ];
}

/**
 * What a target's hacks that landed in the last `span` ms were planned to
 * steal, per second.
 */
function recentIncome(target: Target, now: number, span: number): number {
  const money = target.hacks
    .filter((hack) => hack.landsAt <= now && now - hack.landsAt <= span)
    .reduce((sum, hack) => sum + hack.money, 0);
  return perSecond(money, span);
}

/** One target's row: $/s, what it's doing, its money, security, RAM and timing. */
function targetLine(
  ns: NS,
  state: State,
  target: Target,
  income: number,
  now: number,
): string {
  const { host, reading } = target;
  const workers = state.inFlight.filter((receipt) => receipt.target === host);
  const units = totalUnits(workers);
  return targetRow({
    host,
    earning: income > 0 ? `$${ns.format.number(income)}` : "-",
    activity: activityOf(target),
    money:
      reading && reading.maxMoney > 0
        ? `${((reading.money / reading.maxMoney) * 100).toFixed(0)}%`
        : "-",
    security: reading
      ? `${reading.security.toFixed(1)}/${reading.minSecurity.toFixed(1)}`
      : "-",
    ram: units > 0 ? formatRam(fromUnits(units)) : "-",
    timing: timingOf(target, workers, now),
  });
}

/** Lines a row's cells up under the header. */
function targetRow(row: TargetRow): string {
  return (
    `  ${row.host.padEnd(18)} ${row.earning.padStart(9)}  ` +
    `${row.activity.padEnd(12)} ${row.money.padStart(5)} ` +
    `${row.security.padStart(11)} ${row.ram.padStart(10)}  ${row.timing}`
  );
}

/** What a target is doing, in a word or two. */
function activityOf(target: Target): string {
  const batching = target.phase === "BATCH_IN_FLIGHT";
  if (target.role === "retiring") return "winding down";
  if (target.role === "backup" && batching) return "winding down";
  if (target.role === "quick" && batching) return "quick earner";
  if (target.role === "backup" && target.phase === "BATCH_READY") {
    return "backup";
  }
  return PHASES[target.phase];
}

/** When a target's batches start paying, or when its prep is done. */
function timingOf(target: Target, workers: Receipt[], now: number): string {
  if (target.phase === "BATCH_IN_FLIGHT") {
    if (now >= target.paysAt) return "paying";
    return `pays in ${formatDuration(target.paysAt - now)}`;
  }
  if (target.phase === "PREP_IN_FLIGHT" && workers.length > 0) {
    const done = Math.max(...workers.map((receipt) => receipt.endsAt));
    return `prepped in ${formatDuration(Math.max(0, done - now))}`;
  }
  return "";
}

/** Money made over `ms` milliseconds, per second. */
function perSecond(money: number, ms: number): number {
  return ms > 0 ? (money * MS_PER_SECOND) / ms : 0;
}

/** Dollars per second, as the game formats money. */
function formatIncome(ns: NS, dollarsPerSecond: number): string {
  return `$${ns.format.number(dollarsPerSecond)}/s`;
}

/** A group in a few words, for the status window's last launch. */
function describeGroup(group: Group): string {
  const { purpose, batchCount, target, jobs } = group;
  const size = purpose === "batch" ? `${batchCount}x batch` : purpose;
  return `${size} on ${target} (${formatRam(fromUnits(requiredUnits(jobs)))})`;
}

/** GB, or TB from 1,024 GB up. */
function formatRam(gb: number): string {
  if (gb >= 1_024) return `${(gb / 1_024).toFixed(2)} TB`;
  return `${gb.toFixed(1)} GB`;
}

/** Seconds, or minutes and seconds from a minute up. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
