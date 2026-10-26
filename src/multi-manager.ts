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
  applyGrowSafetyMargin,
  buildPreparedBatch,
  deployWorkers,
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
/** How much of a server's money a batch steals: the picker chooses one of these. */
const HACK_FRACTIONS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9] as const;
/** A batch too big for the network steals less, down to this. */
const MIN_HACK_FRACTION = 0.0025;
/** The picker only changes fraction for this much more modelled income. */
const SWITCH_MARGIN = 1.05;
/** Servers kept beyond those the RAM can keep batching, so the next ones get prepped. */
const PREP_TARGETS = 3;
/** Extra grow threads, as a fraction, in case growth comes up a little short. */
const GROW_SAFETY_MARGIN = 0.02;
/**
 * How close to minimum security and to maximum money counts as prepped. Any
 * security over the minimum makes hack, grow and weaken run long, so the
 * security tolerance only absorbs float rounding.
 */
const SECURITY_TOLERANCE = 1e-6;
const MONEY_READY_RATIO = 0.999;
/** A server at this security can't be priced until it has been weakened once. */
const MAX_SECURITY = 100;
/** Wait after a group's workers end before reading the target again. */
const SETTLE_MS = 250;
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
 * reading, ready for prep or batches, with a group in flight, settling after
 * one, or sitting out after a failed launch.
 */
const PHASES = {
  NEEDS_OBSERVATION: "reading",
  UNAVAILABLE: "can't hack",
  SECURITY_PREP_READY: "needs weaken",
  MONEY_PREP_READY: "needs grow",
  BATCH_READY: "ready",
  PREP_IN_FLIGHT: "prepping",
  BATCH_IN_FLIGHT: "batching",
  SETTLING: "settling",
  BACKOFF: "backing off",
} as const;

type Phase = keyof typeof PHASES;
type Purpose = "batch" | "money-prep" | "security-prep";
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
  moneyPrep: {
    growThreadsNeeded: number;
    growSecurityPerThread: number;
    weakenPerThread: number;
    growTime: number;
    weakenTime: number;
  };
  securityPrep: { threadsNeeded: number; weakenTime: number };
};

type Target = {
  host: string;
  phase: Phase;
  observation: Observation | null;
  economics: Economics | null;
  /** The group it is waiting on; "recovered" for a previous copy's workers. */
  activeGroupId: string | null;
  settleAfter: number;
  backoffUntil: number;
  waitingSince: number;
  /** Batches in its current chain; appended batches are numbered on from here. */
  scheduledBatchCount: number;
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
  /** The targets it can price, best $/GB-s first. */
  ranked: string[];
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
  loops: number;
  startedAt: number;
  launched: number;
  launchFailures: number;
  lastLaunch: string;
  rooted: number;
  deployed: number;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const settings = readSettings(ns);

  const workers = loadWorkers(ns);
  if (!workers) return;

  const otherPid = otherCopyPid(ns);
  if (otherPid !== null) {
    ns.tprint(
      `ERROR: ${ns.getScriptName()} is already running (pid ${otherPid}). ` +
        "Stop it first; this copy won't kill it.",
    );
    return;
  }

  const state = newState(settings, workers);
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
    const decision = launchWhatFits(ns, state);

    renderStatus(ns, state, decision);
    await ns.sleep(nextWakeDelay(state, Date.now()));
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

function newState(settings: Settings, workers: Workers): State {
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
    loops: 0,
    startedAt: Date.now(),
    launched: 0,
    launchFailures: 0,
    lastLaunch: "none yet",
    rooted: 0,
    deployed: 0,
  };
}

/** Roots and deploys to anything new, re-measures RAM, and re-picks targets. */
function refreshNetwork(ns: NS, state: State): void {
  state.hosts = scanNetwork(ns);
  state.rooted = rootAvailableServers(ns, state.hosts);
  state.deployed = deployWorkers(ns, state.hosts, state.deployedHosts);

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
 * network's RAM, and tracks the targets that plan keeps batching plus
 * PREP_TARGETS more to prep next. A target with work in flight is never
 * dropped.
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
  const keep = targetsToKeep(plan, unpricedHosts(ns, hosts));

  for (const host of keep) {
    if (!state.targets.has(host)) state.targets.set(host, newTarget(host));
  }
  for (const [host, target] of state.targets) {
    const busy =
      target.activeGroupId !== null || hasWorkersInFlight(state.inFlight, host);
    if (!keep.includes(host) && !busy) state.targets.delete(host);
  }
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
  return { fraction, ranked: ranked.map(({ host }) => host), fed, income };
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

/**
 * The targets a plan keeps batching, then PREP_TARGETS more to prep. Servers
 * that can't be priced yet get those prep slots first: one weaken lets them
 * be priced, and they are often the richest.
 */
export function targetsToKeep(
  plan: FractionPlan,
  unpriced: string[],
): string[] {
  const batching = plan.ranked.slice(0, plan.fed);
  const toPrep = [...unpriced, ...plan.ranked.slice(plan.fed)];
  return [...batching, ...toPrep.slice(0, PREP_TARGETS)];
}

/** Servers at maximum security, most max money per weaken-second first. */
function unpricedHosts(ns: NS, hosts: string[]): string[] {
  return hosts
    .filter((host) => ns.getServerSecurityLevel(host) >= MAX_SECURITY)
    .map((host) => ({
      host,
      value: ns.getServerMaxMoney(host) / ns.getWeakenTime(host),
    }))
    .sort((a, b) => b.value - a.value)
    .map((row) => row.host);
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
 * Moves targets on once their wait is over. SETTLING and BACKOFF end in a
 * fresh reading, and a group whose workers have all ended goes to SETTLING.
 */
export function closeFinishedGroups(
  targets: Map<string, Target>,
  inFlight: Receipt[],
  now: number,
): void {
  for (const target of targets.values()) {
    if (target.phase === "SETTLING") {
      if (now >= target.settleAfter) {
        target.phase = "NEEDS_OBSERVATION";
        target.activeGroupId = null;
      }
      continue;
    }
    if (target.phase === "BACKOFF") {
      if (now >= target.backoffUntil) target.phase = "NEEDS_OBSERVATION";
      continue;
    }

    const groupId = target.activeGroupId;
    if (groupId === null || groupId === "recovered") continue;
    if (inFlight.some((receipt) => receipt.groupId === groupId)) continue;

    target.phase = "SETTLING";
    target.settleAfter = now + SETTLE_MS;
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
    if (target.phase === "SETTLING" || target.phase === "BACKOFF") continue;

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
  const sizing = batchSizing(state.hackFraction);
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

  const multiplier = observation.maxMoney / Math.max(1, observation.money);
  let growThreadsNeeded = applyGrowSafetyMargin(
    ns.growthAnalyze(host, multiplier, 1),
    GROW_SAFETY_MARGIN,
  );
  if (!Number.isFinite(growThreadsNeeded) || growThreadsNeeded < 1) {
    growThreadsNeeded = 1;
  }
  const { security, minSecurity, growTime, weakenTime } = observation;

  return {
    batch,
    score: batch ? moneyPerGbSecond(batch) : 0,
    moneyPrep: {
      growThreadsNeeded,
      growSecurityPerThread,
      weakenPerThread,
      growTime,
      weakenTime,
    },
    securityPrep: {
      threadsNeeded: Math.max(
        1,
        Math.ceil((security - minSecurity) / weakenPerThread),
      ),
      weakenTime,
    },
  };
}

/**
 * Launches what decide() picks, again and again while groups fit, up to
 * LAUNCHES_PER_LOOP groups or LAUNCH_BUDGET_MS. Returns the last decision.
 */
function launchWhatFits(ns: NS, state: State): Decision {
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
    if (!launchDecision(ns, state, decision, now)) return decision;

    launches++;
    state.runners = readRunners(ns, state);
    const elapsed = Date.now() - startedAt;
    if (launches >= LAUNCHES_PER_LOOP || elapsed >= LAUNCH_BUDGET_MS) {
      return decision;
    }
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
 * Sleeps until the next thing that could need action: a worker's expected
 * end, a settle or backoff ending, an append window opening, or the network
 * refresh. Never less than MIN_SLEEP_MS or more than MAX_SLEEP_MS.
 */
function nextWakeDelay(state: State, now: number): number {
  let wakeAt = Math.min(now + MAX_SLEEP_MS, state.nextNetworkRefresh);

  for (const receipt of state.inFlight) {
    wakeAt = Math.min(wakeAt, receipt.endsAt);
  }
  for (const target of state.targets.values()) {
    if (target.phase === "SETTLING") {
      wakeAt = Math.min(wakeAt, target.settleAfter);
    }
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
 * An append whose target is mid-landing reads prepped again within one batch
 * cycle, so the RAM its wave needs is held and only work that fits around it
 * launches.
 */
export function decide(
  targets: Target[],
  inFlight: Receipt[],
  ctx: PlanContext,
): Decision {
  const candidates: Array<{ target: Target; window: AppendWindow | null }> = [];
  for (const target of targets) {
    const window = appendWindow(target, inFlight);
    if (window) {
      if (ctx.now >= window.launchAt) candidates.push({ target, window });
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
    if (wave.ok && window && !readsPrepped(target)) {
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
    .filter((target) => isPrepPhase(target.phase) && isIdle(target, inFlight))
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

  const chain = inFlight.filter(
    (r) => r.groupId === groupId && r.target === target.host,
  );
  if (chain.length === 0) return null;

  const lastEndAt = Math.max(...chain.map((receipt) => receipt.endsAt));
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
 * The largest prep that fits. Over minimum security that is weaken, or grow
 * with enough weaken for both when money is short too; otherwise grow plus
 * its weaken. Unlike a wave, prep may shrink to partial progress.
 */
export function planPrep(target: Target, ctx: PlanContext): Placement {
  const { observation, economics } = target;
  const groupId = `${TAG}-p${ctx.serial}-${target.host}`;
  const noPlan: Placement = { ok: false, requiredUnits: 0 };
  if (!observation || !economics) return noPlan;
  const { moneyPrep, securityPrep } = economics;

  if (target.phase !== "SECURITY_PREP_READY") {
    if (moneyPrep.growThreadsNeeded < 1) return noPlan;
    return planGrowPrep(target.host, moneyPrep, 0, "money-prep", groupId, ctx);
  }
  if (securityPrep.threadsNeeded < 1) return noPlan;

  const moneyShort =
    observation.money < observation.maxMoney * MONEY_READY_RATIO;
  if (moneyShort && moneyPrep.growThreadsNeeded > 0) {
    const extraWeaken = securityPrep.threadsNeeded;
    const combined = planGrowPrep(
      target.host,
      moneyPrep,
      extraWeaken,
      "security-prep",
      groupId,
      ctx,
    );
    if (combined.ok) return combined;
  }

  const { weakenTime } = securityPrep;
  const max = Math.max(1, Math.floor(securityPrep.threadsNeeded));
  return largestThatFits(ctx.runners, max, (threads) => {
    const weaken = ctx.workers.weaken;
    const job = makeJob(
      `${groupId}-0`,
      "PREP-W",
      weaken,
      threads,
      LAUNCH_LEAD_MS,
      weakenTime,
    );
    return newGroup(groupId, "security-prep", target.host, ctx.now, [job]);
  });
}

/**
 * The largest grow that fits together with the weaken that cancels its
 * security, plus `extraWeaken` threads for security already over minimum.
 */
function planGrowPrep(
  host: string,
  prep: Economics["moneyPrep"],
  extraWeaken: number,
  purpose: Purpose,
  groupId: string,
  ctx: PlanContext,
): Placement {
  const batchId = `${groupId}-0`;
  const { grow, weaken } = ctx.workers;
  const { growTime: g, weakenTime: w } = prep;
  const max = Math.max(1, Math.floor(prep.growThreadsNeeded));

  return largestThatFits(ctx.runners, max, (growThreads) => {
    const growSecurity = growThreads * prep.growSecurityPerThread;
    const weakenThreads =
      Math.max(0, Math.floor(extraWeaken)) +
      Math.max(
        1,
        Math.ceil(growSecurity / Math.max(1e-9, prep.weakenPerThread)),
      );
    const lead = LAUNCH_LEAD_MS;
    return newGroup(groupId, purpose, host, ctx.now, [
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
    settleAfter: 0,
    backoffUntil: 0,
    waitingSince: 0,
    scheduledBatchCount: 0,
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
  if (reading.security > reading.minSecurity + SECURITY_TOLERANCE)
    return "SECURITY_PREP_READY";
  if (reading.money < reading.maxMoney * MONEY_READY_RATIO)
    return "MONEY_PREP_READY";
  return "BATCH_READY";
}

/** Whether its latest reading is at minimum security and maximum money. */
function readsPrepped(target: Target): boolean {
  return (
    target.observation !== null &&
    classify(target.observation) === "BATCH_READY"
  );
}

function isPrepPhase(phase: Phase): boolean {
  return phase === "SECURITY_PREP_READY" || phase === "MONEY_PREP_READY";
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
  if (!(isPrepPhase(phase) && isPrepPhase(target.phase))) {
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

function batchSizing(hackFraction: number): Config {
  const minimumHackFraction = MIN_HACK_FRACTION;
  return {
    hackFraction,
    minimumHackFraction,
    growSafetyMargin: GROW_SAFETY_MARGIN,
  };
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

function renderStatus(ns: NS, state: State, decision: Decision): void {
  state.loops++;
  ns.clearLog();

  const free = fromUnits(state.runners.reduce((sum, r) => sum + r.units, 0));
  const inFlightRam = fromUnits(
    state.inFlight.reduce((sum, r) => sum + r.units, 0),
  );
  const uptime = formatDuration(Date.now() - state.startedAt);

  const lines = [
    "=== MULTI-TARGET SCHEDULER ===",
    `Loop ${state.loops} | up ${uptime} | ` +
      `launched ${state.launched} | failed ${state.launchFailures}`,
    `Network: ${state.hosts.length} known | ${state.runners.length} runners | ` +
      `rooted +${state.rooted} | deployed +${state.deployed}`,
    `RAM: ${formatRam(state.capacityRam)} usable | ` +
      `${formatRam(free)} free | ${formatRam(inFlightRam)} in flight | ` +
      `${formatRam(state.settings.homeReserve)} home reserve`,
    `Batches steal ${(state.hackFraction * 100).toFixed(0)}% of a server's money`,
    `Last launch: ${state.lastLaunch}`,
    ...targetLines(state),
    ...inFlightLines(state),
    ...decisionLines(decision, free),
  ];
  // One entry, not one per line: the game keeps only the newest 50 log
  // entries by default, which cut the top off the status once there were
  // many targets.
  ns.print(lines.join("\n"));
}

function targetLines(state: State): string[] {
  const lines = [`--- targets (${state.targets.size}), best first ---`];
  const byScore = [...state.targets.values()].sort(
    (a, b) => scoreOf(b) - scoreOf(a) || compareText(a.host, b.host),
  );

  for (const { host, phase, observation } of byScore) {
    const money =
      observation && observation.maxMoney > 0
        ? `${((observation.money / observation.maxMoney) * 100).toFixed(0)}%`
        : "-";
    const security = observation
      ? `${observation.security.toFixed(1)}/${observation.minSecurity.toFixed(1)}`
      : "-";
    lines.push(
      `  ${host.padEnd(18)} ${PHASES[phase].padEnd(12)} money ${money.padStart(4)} | ` +
        `sec ${security.padStart(11)}`,
    );
  }
  return lines;
}

function inFlightLines(state: State): string[] {
  if (state.inFlight.length === 0 && state.previousWorkers.length === 0) {
    return ["--- in flight: none ---"];
  }

  type Summary = {
    target: string;
    count: number;
    units: number;
    endsAt: number;
  };
  const groups = new Map<string, Summary>();
  for (const { groupId, target, units, endsAt } of state.inFlight) {
    const group = groups.get(groupId) ?? { target, count: 0, units: 0, endsAt };
    group.count++;
    group.units += units;
    group.endsAt = Math.max(group.endsAt, endsAt);
    groups.set(groupId, group);
  }

  const now = Date.now();
  const lines = [
    `--- in flight: ${groups.size} group(s), ${state.inFlight.length} fragment(s) ---`,
  ];
  for (const [id, group] of groups) {
    lines.push(
      `  ${id.padEnd(26)} ${group.target.padEnd(16)} ` +
        `${String(group.count).padStart(3)} frag | ` +
        `${formatRam(fromUnits(group.units)).padStart(10)} | ` +
        `ends in ${formatDuration(Math.max(0, group.endsAt - now))}`,
    );
  }

  const previous = state.previousWorkers.length;
  if (previous > 0) {
    lines.push(`  recovered from a previous run: ${previous} worker(s)`);
  }
  return lines;
}

function decisionLines(decision: Decision, freeRam: number): string[] {
  if (decision.kind === "idle") {
    return [`--- idle: ${formatRam(freeRam)} free ---`];
  }
  return [
    `--- decision: ${describeGroup(decision.group)} ---`,
    ...fragmentLines(decision.fragments),
  ];
}

/** One line per server a group was placed on. */
function fragmentLines(fragments: Fragment[]): string[] {
  const byHost = new Map<string, { threads: number; units: number }>();
  for (const { host, threads, units } of fragments) {
    const entry = byHost.get(host) ?? { threads: 0, units: 0 };
    entry.threads += threads;
    entry.units += units;
    byHost.set(host, entry);
  }

  return [...byHost].map(
    ([host, { threads, units }]) =>
      `  ${host.padEnd(20)} ${String(threads).padStart(5)} threads | ` +
      formatRam(fromUnits(units)),
  );
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
