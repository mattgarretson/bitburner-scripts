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
 * Uses the RAM of every server you have root on, home last and less
 * --reserve GB. Won't start while another copy is running, and won't kill
 * it either. Targets with workers left over from a previous copy are left
 * alone until those workers end.
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
  growThreadsFor,
  loadWorkers,
  rootAvailableServers,
  scanNetwork,
} from "./hacking-lib.ts";
import type { Batch, Config, WorkerFile, Workers } from "./hacking-lib.ts";

/** Milliseconds between the four landings of one batch. */
const LANDING_GAP_MS = 200;
/** Most batches in one wave. */
const MAX_BATCHES = 20;
/** Head start on every launch, so slow exec calls can't make anything land late. */
const LAUNCH_LEAD_MS = 1_000;
/** A launch is called off if planning ate the head start down below this. */
const LAUNCH_SAFETY_MS = 250;
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
/** Quick earners: how many, and how short their weaken is next to the best target's. */
const QUICK_TARGETS = 3;
const QUICK_WEAKEN_SHARE = 0.5;
/** Extra grow threads, as a fraction, in case growth comes up a little short. */
const GROW_SAFETY_MARGIN = 0.02;
/**
 * How close to minimum security and to maximum money counts as prepped. Any
 * security over the minimum makes hack, grow and weaken run long, so the
 * security tolerance only absorbs float rounding.
 */
const SECURITY_TOLERANCE = 1e-6;
const MONEY_READY_RATIO = 0.999;
/** How long a target sits out after a failed launch. */
const BACKOFF_MS = 5_000;
/** Most groups launched per loop, and the time allowed for launching them. */
const LAUNCHES_PER_LOOP = 4;
const LAUNCH_BUDGET_MS = 500;
/** The loop sleeps until something is due, within these bounds. */
const MIN_SLEEP_MS = 200;
const MAX_SLEEP_MS = 1_000;
/** Starts every group id (worker arg 3), so a restarted manager finds its workers. */
const TAG = "mm";
/** RAM is counted in hundredths of a GB, so free-RAM comparisons are exact. */
const UNITS_PER_GB = 100;
const WORKER_FILE_LIST: readonly string[] = Object.values(WORKER_FILES);

/**
 * Where a target is, and what the status window calls it: waiting for a
 * reading, ready for prep or batches, with a group in flight, or sitting out
 * after a failed launch.
 */
const PHASES = {
  NEEDS_OBSERVATION: "reading",
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

type Observation = {
  valid: boolean;
  money: number;
  maxMoney: number;
  security: number;
  minSecurity: number;
  growTime: number;
  weakenTime: number;
};

/** What a target's batches earn and what its prep needs, from its last reading. */
type Economics = {
  /** Sized for it at minimum security; null if no batch can be built. */
  batch: Batch | null;
  /** Expected $ per GB-second of RAM its batch holds; 0 without a batch. */
  score: number;
  /** What prepping it takes from where it is now. */
  prep: {
    /** Grow threads to refill its money; 0 when it is full. */
    growThreads: number;
    /** Weaken threads for the security it is already over its minimum. */
    excessWeakenThreads: number;
    growSecurityPerThread: number;
    weakenPerThread: number;
    growTime: number;
    weakenTime: number;
  };
};

type Target = {
  host: string;
  phase: Phase;
  observation: Observation | null;
  economics: Economics | null;
  /** The group it is waiting on; "recovered" for a previous copy's workers. */
  activeGroupId: string | null;
  backoffUntil: number;
  waitingSince: number;
  /** Batches in its current chain; appended batches are numbered on from here. */
  scheduledBatchCount: number;
  /** No longer picked: it takes nothing new, and is dropped once its work ends. */
  retiring: boolean;
  /** Picked as a quick earner, to make money while the main targets fill up. */
  quick: boolean;
  /** A backup while every main target is up: it preps, but batches nothing. */
  backup: boolean;
  /** When the first hack of its current chain lands. */
  paysAt: number;
};

/** One worker script run: its threads, delay and expected run time. */
type Job = {
  id: string;
  batchId: string;
  label: string;
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

/** What planning a group works from. `serial` keeps group ids unique. */
type PlanContext = {
  runners: Runner[];
  workers: Workers;
  now: number;
  serial: number;
};

/** What batches stealing one hack fraction would earn, by the picker's model. */
type FractionPlan = {
  fraction: number;
  /** The targets it can price, with their batches, best $/GB-s first. */
  ranked: Array<{ host: string; batch: Batch }>;
  /** How many of them the RAM can keep batching. */
  fed: number;
  /** Modelled $/s with those targets batching flat out. */
  income: number;
};

type State = {
  settings: Settings;
  workers: Workers;
  /** Picked at each network refresh; 0 until the first. */
  hackFraction: number;
  hosts: string[];
  deployedHosts: Set<string>;
  /** Rooted servers with the worker files, as of the last network refresh. */
  workerHosts: Set<string>;
  /** The RAM batches are sized against: all worker RAM, ours in use or not. */
  capacityRam: number;
  runners: Runner[];
  targets: Map<string, Target>;
  /** Launched workers that haven't ended yet. */
  inFlight: Receipt[];
  previousWorkers: Array<{ host: string; pid: number; target: string }>;
  nextNetworkRefresh: number;
  /** The picked plan: how many main targets, and its modelled full-speed $/s. */
  plan: { fed: number; income: number };
  /** Hacking money at start, and money, level and lag read each loop lately. */
  progress: {
    moneyAtStart: number;
    readings: Array<{ at: number; money: number; level: number; late: number }>;
  };
  /** How many ms late the game woke the loop's last sleep: game lag. */
  sleptLate: number;
  startedAt: number;
  launched: number;
  launchFailures: number;
  lastLaunch: string;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const settings = readSettings(ns);

  const workers = loadWorkers(ns);
  if (!workers) return;
  if (!ns.fileExists("Formulas.exe", "home")) {
    ns.tprint(
      `ERROR: ${ns.getScriptName()} prices its batches with Formulas.exe, ` +
        "which isn't on home.",
    );
    return;
  }

  const otherPid = otherCopyPid(ns);
  if (otherPid !== null) {
    ns.tprint(
      `ERROR: ${ns.getScriptName()} is already running (pid ${otherPid}). ` +
        "Stop it first; this copy won't kill it.",
    );
    return;
  }

  const state = newState(settings, workers, hackingMoney(ns));
  refreshNetwork(ns, state);
  adoptPreviousWorkers(ns, state);

  while (true) {
    const now = Date.now();
    if (now >= state.nextNetworkRefresh) refreshNetwork(ns, state);

    state.inFlight = dropEndedWorkers(ns, state.inFlight, now);
    releaseAdoptedTargets(ns, state);
    closeFinishedGroups(state.targets, state.inFlight, now);
    state.runners = readRunners(ns, state);
    readTargets(ns, state, now);
    launchWhatFits(ns, state);

    trackProgress(ns, state);
    renderStatus(ns, state);
    await sleepUntilDue(ns, state);
  }
}

// --- Startup and the network --------------------------------------------------

function readSettings(ns: NS): Settings {
  const flags = ns.flags([["reserve", 8]]);
  return { homeReserve: Math.max(0, Number(flags.reserve) || 0) };
}

/** The PID of another copy of this script on home, if one is running. */
export function otherCopyPid(ns: NS): number | null {
  const self = ns.getScriptName();
  const other = ns
    .ps("home")
    .find((process) => process.filename === self && process.pid !== ns.pid);
  return other ? other.pid : null;
}

function newState(
  settings: Settings,
  workers: Workers,
  hackingAtStart: number,
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
    previousWorkers: [],
    nextNetworkRefresh: 0,
    plan: { fed: 0, income: 0 },
    progress: { moneyAtStart: hackingAtStart, readings: [] },
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
 * network's RAM, and tracks the targets that plan keeps batching, PREP_TARGETS
 * more to prep next, and, while over half the RAM sits idle, a few quick
 * earners. A target no longer picked takes nothing new, and is dropped once
 * its work in flight ends.
 */
function pickTargets(ns: NS, state: State): void {
  const hosts = state.hosts.filter((host) => isMoneyTarget(ns, host));
  const ram = state.capacityRam;
  const plans = HACK_FRACTIONS.map((fraction) => {
    const sizing = batchSizing(fraction);
    const priced: Array<{ host: string; batch: Batch }> = [];
    for (const host of hosts) {
      const batch = buildPreparedBatch(ns, host, state.workers, sizing, ram);
      if (batch) priced.push({ host, batch });
    }
    return planFraction(fraction, priced, ram);
  });

  const plan = choosePlan(plans, state.hackFraction);
  state.hackFraction = plan.fraction;
  state.plan = { fed: plan.fed, income: plan.income };
  const main = targetsToKeep(plan);
  // Quick earners only use RAM that sits idle, as it does after a start. Kept
  // on once RAM is busy, they would take it from the main targets for good.
  const free = fromUnits(state.runners.reduce((sum, r) => sum + r.units, 0));
  const quick = free > state.capacityRam / 2 ? quickEarners(plan, main) : [];
  const keep = [...main, ...quick];

  for (const host of keep) {
    if (!state.targets.has(host)) state.targets.set(host, newTarget(host));
  }
  // Backups batch only to stand in for a main target that is prepping. While
  // every main target is up, a backup's batches would hold RAM the main ones
  // need, for one of its (often long) weaken times.
  const mainHosts = plan.ranked.slice(0, plan.fed).map(({ host }) => host);
  const mainDown = mainHosts.some((host) =>
    isPrepping(state.targets.get(host)),
  );
  for (const [host, target] of state.targets) {
    const busy =
      target.activeGroupId !== null || hasWorkersInFlight(state.inFlight, host);
    target.retiring = !keep.includes(host);
    target.quick = quick.includes(host);
    target.backup = !mainHosts.includes(host) && !target.quick && !mainDown;
    if (target.retiring && !busy) state.targets.delete(host);
  }
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
  priced: Array<{ host: string; batch: Batch }>,
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
    income += ((batch.expectedMoney * 1_000) / cycleMs) * share;
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
export function quickEarners(plan: FractionPlan, keep: string[]): string[] {
  const best = plan.ranked[0];
  if (!best) return [];
  const limit = best.batch.weakenTime * QUICK_WEAKEN_SHARE;
  return plan.ranked
    .filter(
      ({ host, batch }) => !keep.includes(host) && batch.weakenTime <= limit,
    )
    .slice(0, QUICK_TARGETS)
    .map(({ host }) => host);
}

/**
 * Finds workers a previous copy of this script left running. Their targets
 * get nothing new until those workers end, and are then read fresh.
 */
export function adoptPreviousWorkers(ns: NS, state: State): void {
  for (const host of state.hosts) {
    if (!ns.hasRootAccess(host)) continue;

    for (const process of ns.ps(host)) {
      if (!WORKER_FILE_LIST.includes(process.filename)) continue;
      if (!String(process.args[3] ?? "").startsWith(`${TAG}-`)) continue;

      const target = String(process.args[0] ?? "");
      state.previousWorkers.push({ host, pid: process.pid, target });
      if (!target) continue;

      const record = state.targets.get(target) ?? newTarget(target);
      record.activeGroupId = "recovered";
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

/** Once all of a target's previous-copy workers have ended, it is read fresh. */
function releaseAdoptedTargets(ns: NS, state: State): void {
  const ended = state.previousWorkers.filter(
    (worker) => !ns.isRunning(worker.pid, worker.host),
  );
  state.previousWorkers = state.previousWorkers.filter(
    (worker) => !ended.includes(worker),
  );

  for (const worker of ended) {
    const target = state.targets.get(worker.target);
    if (!target || target.activeGroupId !== "recovered") continue;
    if (state.previousWorkers.some((other) => other.target === worker.target))
      continue;

    target.activeGroupId = null;
    target.phase = "NEEDS_OBSERVATION";
  }
}

/**
 * Sends a target back for a fresh reading once its backoff is over, or once
 * every worker of its group has ended: a worker's effect has landed by the
 * time its process ends, so the reading can be taken straight away.
 */
export function closeFinishedGroups(
  targets: Map<string, Target>,
  inFlight: Receipt[],
  now: number,
): void {
  for (const target of targets.values()) {
    if (target.phase === "BACKOFF") {
      if (now >= target.backoffUntil) target.phase = "NEEDS_OBSERVATION";
      continue;
    }

    const groupId = target.activeGroupId;
    if (groupId === null || groupId === "recovered") continue;
    if (inFlight.some((receipt) => receipt.groupId === groupId)) continue;

    target.phase = "NEEDS_OBSERVATION";
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

    const observation = observe(ns, target.host);
    const economics = observation.valid
      ? computeEconomics(ns, state, target.host, observation)
      : null;
    recordObservation(target, observation, economics, now);
  }
}

/**
 * Reads a target whose batches are landing. While it reads prepped, between
 * one batch's last landing and the next one's hack, its batch is rebuilt
 * from this reading for the next append.
 */
function readRunningChain(ns: NS, state: State, target: Target): void {
  const observation = observe(ns, target.host);
  target.observation = observation;
  if (!readsPrepped(target)) return;
  target.economics = computeEconomics(ns, state, target.host, observation);
}

/** A reading; invalid if the target can't be hacked for money now. */
function observe(ns: NS, host: string): Observation {
  if (!isMoneyTarget(ns, host)) {
    return {
      valid: false,
      money: 0,
      maxMoney: 0,
      security: 0,
      minSecurity: 0,
      growTime: 0,
      weakenTime: 0,
    };
  }

  const server = ns.getServer(host);
  return {
    valid: true,
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
  observation: Observation,
): Economics {
  const rate = levelingRate(state.progress.readings);
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

  const { money, maxMoney, security, minSecurity } = observation;
  const moneyShort = money < maxMoney * MONEY_READY_RATIO;
  const excess = security - minSecurity;

  return {
    batch,
    score: batch ? moneyPerGbSecond(batch) : 0,
    prep: {
      growThreads: moneyShort ? growThreadsToRefill(ns, host) : 0,
      excessWeakenThreads:
        excess > SECURITY_TOLERANCE ? Math.ceil(excess / weakenPerThread) : 0,
      growSecurityPerThread,
      weakenPerThread,
      growTime: observation.growTime,
      weakenTime: observation.weakenTime,
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
): { ok: true; receipts: Receipt[] } | { ok: false; reason: string } {
  const plannedAt = Date.now();
  const skew = plannedAt - group.plannedAt;
  if (LAUNCH_LEAD_MS - skew < LAUNCH_SAFETY_MS) {
    return {
      ok: false,
      reason: `planning consumed ${skew}ms of the ${LAUNCH_LEAD_MS}ms lead`,
    };
  }

  const receipts: Receipt[] = [];
  const ordered = [...fragments].sort((a, b) => a.job.delay - b.job.delay);
  for (const { job, host, threads, units } of ordered) {
    const pid = ns.exec(
      job.worker.file,
      host,
      { threads, temporary: true },
      group.target,
      job.delay,
      plannedAt,
      job.batchId,
      job.label,
    );
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
      endsAt: plannedAt + job.delay + job.duration,
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
    const window = appendWindow(target, state.inFlight);
    if (window && window.launchAt > now) {
      wakeAt = Math.min(wakeAt, window.launchAt);
    }
  }

  return Math.max(MIN_SLEEP_MS, Math.min(MAX_SLEEP_MS, wakeAt - now));
}

// --- Deciding what to launch --------------------------------------------------

/**
 * Picks the one group to launch next: the best complete wave that fits, or
 * else the best prep that fits without holding RAM a waiting batch needs.
 * A running chain whose next wave can't go yet, because its window hasn't
 * opened or its target is mid-landing, will go within one wave. So it holds
 * the RAM that wave needs, and only work that fits around it launches: a
 * worse target would hold that RAM for a whole weaken time.
 */
export function decide(
  targets: Target[],
  inFlight: Receipt[],
  ctx: PlanContext,
): Decision {
  const candidates: Array<{ target: Target; window: AppendWindow | null }> = [];
  for (const target of targets) {
    if (target.retiring || target.backup) continue;
    const window = appendWindow(target, inFlight);
    if (window) {
      candidates.push({ target, window });
      continue;
    }
    if (target.phase !== "BATCH_READY" || !isIdle(target, inFlight)) continue;
    if (scoreOf(target) > 0) candidates.push({ target, window: null });
  }
  candidates.sort(
    (a, b) =>
      scoreOf(b.target) - scoreOf(a.target) ||
      compareText(a.target.host, b.target.host),
  );

  let runners = ctx.runners;
  let waitingBatchUnits: number | null = null;
  for (const { target, window } of candidates) {
    const batch = target.economics?.batch;
    if (!batch) continue;

    const wave = planWave(target, batch, window, { ...ctx, runners });
    const notYet =
      window !== null && (ctx.now < window.launchAt || !readsPrepped(target));
    if (wave.ok && notYet) {
      runners = withoutFragments(runners, wave.fragments);
      continue;
    }
    if (wave.ok) {
      const { group, fragments } = wave;
      return { kind: "batch", target, group, fragments };
    }
    waitingBatchUnits ??= wave.requiredUnits;
  }

  const prepCtx = { ...ctx, runners };
  const freeUnits = runners.reduce((sum, runner) => sum + runner.units, 0);
  const prepTargets = targets
    .filter((target) => target.phase === "PREP_READY" && !target.retiring)
    .filter((target) => isIdle(target, inFlight))
    .sort(byPrepOrder);
  for (const target of prepTargets) {
    const prep = planPrep(target, prepCtx);
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
  if (groupId === null || groupId === "recovered") return null;

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
    scoreOf(b) - scoreOf(a) ||
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

  const releasedByThen = inFlight
    .filter((receipt) => receipt.endsAt <= windowStart)
    .reduce((sum, receipt) => sum + receipt.units, 0);
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
  window: AppendWindow | null,
  ctx: PlanContext,
): Placement {
  const groupId =
    window && target.activeGroupId
      ? target.activeGroupId
      : `${TAG}-b${ctx.serial}-${target.host}`;
  const firstIndex = window ? target.scheduledBatchCount : 0;
  const landingOffset = window
    ? Math.max(
        0,
        window.lastEndAt +
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
    const appending = window !== null;
    return newGroup(
      groupId,
      "batch",
      target.host,
      ctx.now,
      jobs,
      count,
      appending,
    );
  });
}

/**
 * The largest prep that fits: grow, if money is short, with weaken for its
 * security and for any already over minimum. If no grow fits beside all that
 * weaken, just the weaken. Unlike a wave, prep may shrink to partial progress.
 */
export function planPrep(target: Target, ctx: PlanContext): Placement {
  const groupId = `${TAG}-p${ctx.serial}-${target.host}`;
  const noPlan: Placement = { ok: false, requiredUnits: 0 };
  if (!target.economics) return noPlan;
  const { prep } = target.economics;

  if (prep.growThreads >= 1) {
    const withGrow = planGrowPrep(target.host, prep, groupId, ctx);
    if (withGrow.ok || prep.excessWeakenThreads < 1) return withGrow;
  }
  if (prep.excessWeakenThreads < 1) return noPlan;

  return largestThatFits(ctx.runners, prep.excessWeakenThreads, (threads) => {
    const weaken = ctx.workers.weaken;
    const job = makeJob(
      `${groupId}-0`,
      "PREP-W",
      weaken,
      threads,
      LAUNCH_LEAD_MS,
      prep.weakenTime,
    );
    return newGroup(groupId, "prep", target.host, ctx.now, [job]);
  });
}

/**
 * The largest grow that fits together with the weaken that cancels its
 * security, plus the weaken for security already over minimum.
 */
function planGrowPrep(
  host: string,
  prep: Economics["prep"],
  groupId: string,
  ctx: PlanContext,
): Placement {
  const batchId = `${groupId}-0`;
  const { grow, weaken } = ctx.workers;
  const { growTime: g, weakenTime: w } = prep;
  const max = Math.max(1, Math.floor(prep.growThreads));

  return largestThatFits(ctx.runners, max, (growThreads) => {
    const growSecurity = growThreads * prep.growSecurityPerThread;
    const weakenThreads =
      prep.excessWeakenThreads +
      Math.max(
        1,
        Math.ceil(growSecurity / Math.max(1e-9, prep.weakenPerThread)),
      );
    const lead = LAUNCH_LEAD_MS;
    return newGroup(groupId, "prep", host, ctx.now, [
      makeJob(
        batchId,
        "PREP-G",
        grow,
        growThreads,
        lead + Math.max(0, w - g),
        g,
      ),
      makeJob(
        batchId,
        "PREP-W",
        weaken,
        weakenThreads,
        lead + LANDING_GAP_MS,
        w,
      ),
    ]);
  });
}

/**
 * Binary-searches the largest size, from 1 to `max`, whose group fits. Waves
 * shrink by whole batches and prep by whole grow/weaken pairs, so whatever
 * fits is complete. When nothing fits, says how much a size-1 group needs.
 */
function largestThatFits(
  runners: Runner[],
  max: number,
  groupOfSize: (size: number) => Group,
): Placement {
  let low = 1;
  let high = max;
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
    const placed = fragments
      .filter((fragment) => fragment.host === runner.host)
      .reduce((sum, fragment) => sum + fragment.units, 0);
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
function byPlacementOrder(
  a: { host: string; units: number },
  b: { host: string; units: number },
): number {
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
  const { hackThreads, growThreads, weakenHackThreads, weakenGrowThreads } =
    batch;
  const { hackTime: h, growTime: g, weakenTime: w } = batch;
  const lead = LAUNCH_LEAD_MS;
  const gap = LANDING_GAP_MS;
  const job = (
    label: string,
    worker: WorkerFile,
    threads: number,
    delay: number,
    duration: number,
  ): Job => makeJob(batchId, label, worker, threads, delay + offset, duration);

  return [
    job("H", workers.hack, hackThreads, lead + Math.max(0, w - h), h),
    job("W1", workers.weaken, weakenHackThreads, lead + gap, w),
    job("G", workers.grow, growThreads, lead + Math.max(0, w - g) + 2 * gap, g),
    job("W2", workers.weaken, weakenGrowThreads, lead + 3 * gap, w),
  ];
}

export function makeJob(
  batchId: string,
  label: string,
  worker: WorkerFile,
  threads: number,
  delay: number,
  duration: number,
): Job {
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

export function newGroup(
  id: string,
  purpose: Purpose,
  target: string,
  plannedAt: number,
  jobs: Job[],
  batchCount: number = 0,
  continuation: boolean = false,
): Group {
  const lastEnd = Math.max(0, ...jobs.map((job) => job.delay + job.duration));
  const lastEndAt = plannedAt + lastEnd;
  return {
    id,
    purpose,
    target,
    plannedAt,
    jobs,
    batchCount,
    lastEndAt,
    continuation,
  };
}

// --- Target state ---------------------------------------------------------------

export function newTarget(host: string): Target {
  return {
    host,
    phase: "NEEDS_OBSERVATION",
    observation: null,
    economics: null,
    activeGroupId: null,
    backoffUntil: 0,
    waitingSince: 0,
    scheduledBatchCount: 0,
    retiring: false,
    quick: false,
    backup: false,
    paysAt: 0,
  };
}

/** What a reading says the target needs next. */
export function classify(
  reading: Pick<
    Observation,
    "valid" | "money" | "maxMoney" | "security" | "minSecurity"
  >,
): Phase {
  if (!reading.valid) return "UNAVAILABLE";
  const securityHigh =
    reading.security > reading.minSecurity + SECURITY_TOLERANCE;
  const moneyShort = reading.money < reading.maxMoney * MONEY_READY_RATIO;
  return securityHigh || moneyShort ? "PREP_READY" : "BATCH_READY";
}

/** Whether its latest reading is at minimum security and maximum money. */
function readsPrepped(target: Target): boolean {
  return (
    target.observation !== null &&
    classify(target.observation) === "BATCH_READY"
  );
}

/** Stores a fresh reading and moves the target to the phase it calls for. */
export function recordObservation(
  target: Target,
  observation: Observation,
  economics: Economics | null,
  now: number,
): void {
  const phase = classify(observation);
  // A target still waiting for prep keeps its place in the prep queue.
  if (!(phase === "PREP_READY" && target.phase === "PREP_READY")) {
    target.waitingSince = now;
  }
  target.phase = phase;
  target.observation = observation;
  target.economics = economics;
  target.activeGroupId = null;
  target.scheduledBatchCount = 0;
}

export function markLaunched(target: Target, group: Group): void {
  target.activeGroupId = group.id;
  if (group.purpose !== "batch") {
    target.phase = "PREP_IN_FLIGHT";
    return;
  }
  target.phase = "BATCH_IN_FLIGHT";
  target.scheduledBatchCount += group.batchCount;
  if (!group.continuation) target.paysAt = firstHackLanding(group);
}

/** When a wave's first hack lands. */
function firstHackLanding(group: Group): number {
  const hacks = group.jobs.filter((job) => job.label === "H");
  const first = Math.min(...hacks.map((job) => job.delay + job.duration));
  return group.plannedAt + first;
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
function batchSizing(hackFraction: number, levelsPerMs: number = 0): Config {
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
export function levelingRate(readings: Array<{ level: number }>): number {
  if (readings.length < 2) return 0;
  const gained = readings[readings.length - 1].level - readings[0].level;
  return Math.max(0, gained) / LEVELING_WINDOW_MS;
}

/** How long a batch holds its RAM: from launch to its last landing. */
function batchHoldMs(batch: Batch): number {
  return LAUNCH_LEAD_MS + batch.weakenTime + 3 * LANDING_GAP_MS;
}

/** Expected $ per GB-second of RAM the batch holds. */
function moneyPerGbSecond(batch: Batch): number {
  return batch.expectedMoney / ((batch.ramNeeded * batchHoldMs(batch)) / 1_000);
}

/** Expected $ per GB-second of its batch; 0 if it has none. */
function scoreOf(target: Target): number {
  return target.economics?.score ?? 0;
}

export function hasWorkersInFlight(inFlight: Receipt[], host: string): boolean {
  return inFlight.some((receipt) => receipt.target === host);
}

export function requiredUnits(jobs: Job[]): number {
  return jobs.reduce(
    (sum, job) => sum + toUnits(job.worker.ram) * job.threads,
    0,
  );
}

function toUnits(gb: number): number {
  return Math.round(gb * UNITS_PER_GB);
}

function fromUnits(units: number): number {
  return units / UNITS_PER_GB;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Status window --------------------------------------------------------------

/** Hacking money made since the last augmentation install. */
function hackingMoney(ns: NS): number {
  return ns.getMoneySources().sinceInstall.hacking;
}

/**
 * Reads hacking money and level, keeping LEVELING_WINDOW_MS of readings: the
 * status window shows income and lag from them, and batches are sized for
 * leveling.
 */
function trackProgress(ns: NS, state: State): void {
  const now = Date.now();
  const { readings } = state.progress;
  const level = ns.getHackingLevel();
  const late = state.sleptLate;
  readings.push({ at: now, money: hackingMoney(ns), level, late });
  while (readings.length > 1 && now - readings[0].at > LEVELING_WINDOW_MS) {
    readings.shift();
  }
}

function renderStatus(ns: NS, state: State): void {
  ns.clearLog();
  const now = Date.now();
  const inUse = fromUnits(state.inFlight.reduce((sum, r) => sum + r.units, 0));
  const free = fromUnits(state.runners.reduce((sum, r) => sum + r.units, 0));
  const usedShare = state.capacityRam > 0 ? inUse / state.capacityRam : 0;
  const { readings, moneyAtStart } = state.progress;
  const last = readings[readings.length - 1];
  const recent = readings.filter(
    (reading) => now - reading.at <= INCOME_WINDOW_MS,
  );
  const first = recent[0] ?? last;
  const lastMinute = perSecond(last.money - first.money, last.at - first.at);
  const sinceStart = perSecond(
    last.money - moneyAtStart,
    now - state.startedAt,
  );
  const levelsPerHour = levelingRate(readings) * 3_600_000;
  const lateTotal = recent.reduce((sum, reading) => sum + reading.late, 0);
  const lateWorst = recent.reduce((worst, r) => Math.max(worst, r.late), 0);

  const lines = [
    `=== MULTI-MANAGER === up ${formatDuration(now - state.startedAt)} | ` +
      `${state.launched} launches, ${state.launchFailures} failed`,
    `Hacking: ${formatIncome(ns, lastMinute)} last minute | ` +
      `${formatIncome(ns, sinceStart)} since start | level ${last.level} ` +
      `(+${levelsPerHour.toFixed(0)}/h)`,
    `Game lag: ${(lateTotal / Math.max(1, recent.length)).toFixed(0)} ms ` +
      `average, ${lateWorst.toFixed(0)} ms worst, last minute ` +
      `(landings are ${LANDING_GAP_MS} ms apart)`,
    `RAM: ${formatRam(state.capacityRam)} on ${state.runners.length} servers | ` +
      `${(usedShare * 100).toFixed(0)}% in use | ${formatRam(free)} free | ` +
      `home reserve ${formatRam(state.settings.homeReserve)}`,
    `Plan: batches steal ${(state.hackFraction * 100).toFixed(0)}% | ` +
      `${state.plan.fed} main target(s) | full speed ` +
      formatIncome(ns, state.plan.income),
    `Last launch: ${state.lastLaunch}`,
    ...targetLines(state, now),
  ];
  const previous = state.previousWorkers.length;
  if (previous > 0) {
    lines.push(`Waiting on ${previous} worker(s) left by a previous run`);
  }
  // One entry, not one per line: the game keeps only the newest 50 log
  // entries by default, which cut the top off the status once there were
  // many targets.
  ns.print(lines.join("\n"));
}

/** A header, then one line per target, best first. */
function targetLines(state: State, now: number): string[] {
  const targets = [...state.targets.values()].sort(
    (a, b) => scoreOf(b) - scoreOf(a) || compareText(a.host, b.host),
  );
  return [
    `--- targets (${targets.length}), best first ---`,
    targetRow("target", "doing", "money", "security", "RAM", "when"),
    ...targets.map((target) => targetLine(state, target, now)),
  ];
}

function targetLine(state: State, target: Target, now: number): string {
  const { host, observation } = target;
  const workers = state.inFlight.filter((receipt) => receipt.target === host);
  const units = workers.reduce((sum, receipt) => sum + receipt.units, 0);
  const money =
    observation && observation.maxMoney > 0
      ? `${((observation.money / observation.maxMoney) * 100).toFixed(0)}%`
      : "-";
  const security = observation
    ? `${observation.security.toFixed(1)}/${observation.minSecurity.toFixed(1)}`
    : "-";
  const ram = units > 0 ? formatRam(fromUnits(units)) : "-";
  const timing = timingOf(target, workers, now);
  return targetRow(host, activityOf(target), money, security, ram, timing);
}

/** Lines a target's columns up under the header. */
function targetRow(
  host: string,
  activity: string,
  money: string,
  security: string,
  ram: string,
  timing: string,
): string {
  return (
    `  ${host.padEnd(18)} ${activity.padEnd(12)} ${money.padStart(5)} ` +
    `${security.padStart(11)} ${ram.padStart(10)}  ${timing}`
  );
}

/** What a target is doing, in a word or two. */
function activityOf(target: Target): string {
  const batching = target.phase === "BATCH_IN_FLIGHT";
  if (target.retiring || (target.backup && batching)) return "winding down";
  if (target.quick && batching) return "quick earner";
  if (target.backup && target.phase === "BATCH_READY") return "backup";
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
  return ms > 0 ? (money * 1_000) / ms : 0;
}

function formatIncome(ns: NS, dollarsPerSecond: number): string {
  return `$${ns.format.number(dollarsPerSecond)}/s`;
}

function describeGroup(group: Group): string {
  const { purpose, batchCount, target, jobs } = group;
  const size = purpose === "batch" ? `${batchCount}x batch` : purpose;
  return `${size} on ${target} (${formatRam(fromUnits(requiredUnits(jobs)))})`;
}

function formatRam(gb: number): string {
  if (gb >= 1_024) return `${(gb / 1_024).toFixed(2)} TB`;
  return `${gb.toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
