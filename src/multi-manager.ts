/**
 * multi-manager.ts — hacks several servers at once with timed hack/weaken/grow/weaken batches
 *
 * Each loop it reads every target, preps the ones that aren't at minimum
 * security and maximum money, and launches waves of complete batches on the
 * ones that are, best expected $/s first. Everything is planned from that
 * loop's reading, because every hacking level shortens hack, grow and weaken.
 * Batches come first: prep only gets RAM no batch could use, and never RAM a
 * waiting batch will need. A wave that is still landing gets more batches
 * appended behind it whenever its target reads prepped between landings.
 * Once all of a target's workers have ended, it is read again before
 * anything new is planned for it.
 *
 * Uses the RAM of every server you have root on, home last and less
 * --reserve GB. Won't start while another copy is running, and won't kill
 * it either. Targets with workers left over from a previous copy are left
 * alone until those workers end.
 *
 * Usage: run multi-manager.ts [--hack 0.10] [--targets 8] [--reserve 8]
 *   --hack     most of a server's money one batch steals (0.0025 to 0.5)
 *   --targets  how many servers it hacks at once
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
/** Range for --hack. A batch that doesn't fit steals less, down to the minimum. */
const MIN_HACK_FRACTION = 0.0025;
const MAX_HACK_FRACTION = 0.5;
/** Extra grow threads, as a fraction, in case growth comes up a little short. */
const GROW_SAFETY_MARGIN = 0.02;
/**
 * How close to minimum security and to maximum money counts as prepped. Any
 * security over the minimum makes hack, grow and weaken run long, so the
 * security tolerance only absorbs float rounding.
 */
const SECURITY_TOLERANCE = 1e-6;
const MONEY_READY_RATIO = 0.999;
/** Wait after a group's workers end before reading the target again. */
const SETTLE_MS = 250;
/** How long a target sits out after a failed launch or a lost worker. */
const BACKOFF_MS = 5_000;
/** A worker still running this long after its expected end is LATE. */
const LATE_TOLERANCE_MS = 2_000;
/** A worker gone more than this long before its expected end is LOST. */
const EARLY_TOLERANCE_MS = 500;
/** Prep targets that have waited this long go to the front of the prep queue. */
const PREP_AGING_MS = 60_000;
/** Most groups launched per loop, and the time allowed for launching them. */
const LAUNCHES_PER_LOOP = 4;
const LAUNCH_BUDGET_MS = 500;
/** The loop sleeps until something is due, within these bounds. */
const MIN_SLEEP_MS = 200;
const MAX_SLEEP_MS = 1_000;
/** Workers not yet due to end are checked this often, to catch early deaths. */
const FULL_CHECK_MS = 2_000;
/** Starts every group id (worker arg 3), so a restarted manager finds its workers. */
const TAG = "mm";
/** RAM is counted in hundredths of a GB, so free-RAM comparisons are exact. */
const UNITS_PER_GB = 100;
const WORKER_FILE_LIST: readonly string[] = Object.values(WORKER_FILES);

/** The phase a target must still be in when each kind of group launches. */
const READY_PHASE = {
  batch: "BATCH_READY",
  "money-prep": "MONEY_PREP_READY",
  "security-prep": "SECURITY_PREP_READY",
} as const;

type Purpose = keyof typeof READY_PHASE;
type Settings = {
  hackFraction: number;
  maxTargets: number;
  homeReserve: number;
};

/**
 * Where a target is: waiting for a reading, ready for prep or batches, with a
 * group in flight, settling after one, or sitting out after a failure.
 */
type Phase =
  | "NEEDS_OBSERVATION"
  | "UNAVAILABLE"
  | "SECURITY_PREP_READY"
  | "MONEY_PREP_READY"
  | "BATCH_READY"
  | "PREP_IN_FLIGHT"
  | "BATCH_IN_FLIGHT"
  | "SETTLING"
  | "BACKOFF";

/** Why a target got nothing, shown when RAM sits idle. */
type ReasonCode =
  | "NO_ELIGIBLE_TARGETS"
  | "ALL_TARGETS_BUSY"
  | "WAITING_FOR_OBSERVATION"
  | "LAUNCH_BACKOFF"
  | "NO_PROFITABLE_BATCH"
  | "COMPLETE_BATCH_TOO_LARGE"
  | "PREP_GROUP_TOO_LARGE"
  | "RESERVED_FOR_BATCH_WINDOW"
  | "RUNNER_FRAGMENTATION"
  | "BELOW_SMALLEST_THREAD"
  | "WORKERS_NOT_DEPLOYED"
  | "INVALID_PLAN";

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
  moneyPerSecond: number;
  /** Prep queue order: moneyPerSecond, or max money per weaken-second without a batch. */
  prepPriority: number;
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
  /** "Complete batch too large" rejections since its last batch launched. */
  batchTooLargeCount: number;
  /** Times its hack fraction has been cut by 0.8 because batches didn't fit. */
  batchSizeNotches: number;
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

/** A group placed on servers, or why it doesn't fit. */
type Placement =
  | { ok: true; group: Group; fragments: Fragment[] }
  | { ok: false; code: ReasonCode; requiredUnits: number };

/** A rooted server's free RAM. Without the worker files, its RAM is blocked. */
type Runner = { host: string; units: number; blockedUnits: number };

/** A launched worker process. */
type Receipt = {
  groupId: string;
  target: string;
  host: string;
  pid: number;
  units: number;
  endsAt: number;
  status: "running" | "late" | "finished" | "lost";
};

/** Launched workers, and per group how many went late or were lost. */
type InFlight = {
  receipts: Receipt[];
  faults: Map<string, { lost: number; late: number }>;
};

type Reason = { host: string; code: ReasonCode };

type Decision =
  | {
      kind: "batch" | "prep";
      target: Target;
      group: Group;
      fragments: Fragment[];
      reasons: Reason[];
    }
  | { kind: "idle"; dominantReason: ReasonCode; reasons: Reason[] };

/** When a new wave can launch to land right behind a running chain. */
type AppendWindow = { lastEndAt: number; launchAt: number };

/** What planning a group works from. `serial` keeps group ids unique. */
type PlanContext = {
  runners: Runner[];
  workers: Workers;
  now: number;
  serial: number;
};

type State = {
  settings: Settings;
  workers: Workers;
  hosts: string[];
  deployedHosts: Set<string>;
  /** Rooted servers with the worker files, as of the last network refresh. */
  workerHosts: Set<string>;
  /** The RAM batches are sized against: all worker RAM, ours in use or not. */
  capacityRam: number;
  runners: Runner[];
  targets: Map<string, Target>;
  inFlight: InFlight;
  previousWorkers: Array<{ host: string; pid: number; target: string }>;
  nextNetworkRefresh: number;
  nextFullCheck: number;
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

    checkWorkers(ns, state, now);
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
  const flags = ns.flags([
    ["targets", 8],
    ["hack", 0.1],
    ["reserve", 8],
  ]);
  const hack = Number(flags.hack);

  return {
    hackFraction: Number.isFinite(hack)
      ? Math.min(MAX_HACK_FRACTION, Math.max(MIN_HACK_FRACTION, hack))
      : MIN_HACK_FRACTION,
    maxTargets: Math.max(1, Math.floor(Number(flags.targets) || 8)),
    homeReserve: Math.max(0, Number(flags.reserve) || 0),
  };
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
    hosts: ["home"],
    deployedHosts: new Set(),
    workerHosts: new Set(["home"]),
    capacityRam: 0,
    runners: [],
    targets: new Map(),
    inFlight: { receipts: [], faults: new Map() },
    previousWorkers: [],
    nextNetworkRefresh: 0,
    nextFullCheck: 0,
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
  trackBestTargets(ns, state);
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
 * Tracks the --targets servers with the best expected $/s, and never drops one
 * that still has work in flight. A server at 100 security can't be modelled,
 * so until it is prepped it scores max money per second of weaken time.
 */
function trackBestTargets(ns: NS, state: State): void {
  const sizing = batchSizing(state.settings.hackFraction);
  const ram = state.capacityRam;
  const scored: Array<{ host: string; score: number }> = [];

  for (const host of state.hosts) {
    if (!isMoneyTarget(ns, host)) continue;

    const batch = buildPreparedBatch(ns, host, state.workers, sizing, ram);
    if (batch) {
      scored.push({ host, score: wavesMoneyPerSecond(batch, ram) });
    } else if (ns.getServerSecurityLevel(host) >= 100) {
      const weakenSeconds = Math.max(0.001, ns.getWeakenTime(host) / 1_000);
      scored.push({ host, score: ns.getServerMaxMoney(host) / weakenSeconds });
    }
  }

  const best = scored
    .sort((a, b) => b.score - a.score || a.host.localeCompare(b.host))
    .slice(0, state.settings.maxTargets)
    .map((row) => row.host);

  for (const host of best) {
    if (!state.targets.has(host)) state.targets.set(host, newTarget(host));
  }
  for (const [host, target] of state.targets) {
    const busy =
      target.activeGroupId !== null || hasLiveReceipts(state.inFlight, host);
    if (!best.includes(host) && !busy) state.targets.delete(host);
  }
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

/**
 * Marks each launched worker running, late, lost or finished. Workers not yet
 * due to end are only checked every FULL_CHECK_MS, to catch early deaths.
 */
export function checkWorkers(ns: NS, state: State, now: number): void {
  const { inFlight } = state;
  const fullCheck = now >= state.nextFullCheck;
  if (fullCheck) state.nextFullCheck = now + FULL_CHECK_MS;

  for (const receipt of inFlight.receipts) {
    if (!isLive(receipt)) continue;
    if (!fullCheck && now < receipt.endsAt) continue;

    const running = ns.isRunning(receipt.pid, receipt.host);
    const status = workerStatus(receipt, running, now);
    if (status === receipt.status) continue;

    if (status === "lost" || status === "late") {
      const faults = inFlight.faults.get(receipt.groupId) ?? {
        lost: 0,
        late: 0,
      };
      faults[status]++;
      inFlight.faults.set(receipt.groupId, faults);
    }
    receipt.status = status;
  }
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
 * fresh reading. A group whose workers have all stopped ends in SETTLING, or
 * in BACKOFF if any were lost. Stopped workers are then dropped.
 */
export function closeFinishedGroups(
  targets: Map<string, Target>,
  inFlight: InFlight,
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
    const workers = inFlight.receipts.filter((r) => r.groupId === groupId);
    if (workers.length === 0 || workers.some(isLive)) continue;

    if ((inFlight.faults.get(groupId)?.lost ?? 0) > 0) {
      backOff(target, now);
    } else {
      target.phase = "SETTLING";
      target.settleAfter = now + SETTLE_MS;
    }
    inFlight.faults.delete(groupId);
  }

  inFlight.receipts = inFlight.receipts.filter(isLive);
}

/** Free RAM on every rooted server, less the home reserve. */
export function readRunners(ns: NS, state: State): Runner[] {
  return state.hosts
    .filter((host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0)
    .map((host) => {
      const reserve = host === "home" ? state.settings.homeReserve : 0;
      const free =
        ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
      const units = toUnits(Math.max(0, free));
      return state.workerHosts.has(host)
        ? { host, units, blockedUnits: 0 }
        : { host, units: 0, blockedUnits: units };
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
    if (hasLiveReceipts(state.inFlight, target.host)) continue;
    if (target.phase === "SETTLING" || target.phase === "BACKOFF") continue;

    const observation = observe(ns, target.host);
    const economics = observation.valid
      ? computeEconomics(ns, state, target, observation)
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
  target.economics = computeEconomics(ns, state, target, observation);
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
  target: Target,
  observation: Observation,
): Economics {
  const { host } = target;
  // Each notch from batches not fitting cuts what a batch steals by a fifth.
  const hackFraction = Math.max(
    MIN_HACK_FRACTION,
    state.settings.hackFraction * Math.pow(0.8, target.batchSizeNotches),
  );
  const sizing = batchSizing(hackFraction);
  const batch = buildPreparedBatch(
    ns,
    host,
    state.workers,
    sizing,
    state.capacityRam,
  );
  const moneyPerSecond = batch
    ? wavesMoneyPerSecond(batch, state.capacityRam)
    : 0;
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
  const { security, minSecurity, maxMoney, growTime, weakenTime } = observation;

  return {
    batch,
    moneyPerSecond,
    prepPriority:
      moneyPerSecond > 0
        ? moneyPerSecond
        : Math.max(0, maxMoney) / Math.max(0.001, weakenTime / 1_000),
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
    noteBatchesTooLarge(state.targets, decision);
    if (!launchDecision(ns, state, decision, now)) return decision;

    launches++;
    state.runners = readRunners(ns, state);
    const elapsed = Date.now() - startedAt;
    if (launches >= LAUNCHES_PER_LOOP || elapsed >= LAUNCH_BUDGET_MS) {
      return decision;
    }
  }
}

/**
 * Every third "complete batch too large" since a target's last batch cuts its
 * hack fraction another notch, and has it read again to resize its batch.
 */
export function noteBatchesTooLarge(
  targets: Map<string, Target>,
  decision: Decision,
): void {
  const hosts = new Set(
    decision.reasons
      .filter((reason) => reason.code === "COMPLETE_BATCH_TOO_LARGE")
      .map((reason) => reason.host),
  );

  for (const host of hosts) {
    const target = targets.get(host);
    if (!target || target.activeGroupId !== null) continue;

    target.batchTooLargeCount++;
    const notches = Math.floor(target.batchTooLargeCount / 3);
    if (notches > target.batchSizeNotches) target.phase = "NEEDS_OBSERVATION";
    target.batchSizeNotches = notches;
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

  const launch = launchGroup(ns, group, fragments, state.settings.homeReserve);
  if (!launch.ok) {
    state.launchFailures++;
    state.lastLaunch = `FAILED ${target.host}: ${launch.reason}`;
    // A failed append is offered again next loop; the chain keeps landing.
    if (!group.continuation) backOff(target, now);
    return false;
  }

  state.inFlight.receipts.push(...launch.receipts);
  markLaunched(target, group);
  state.launched++;
  state.lastLaunch = `${describeGroup(group)} on ${launch.receipts.length} pid(s)`;
  return true;
}

/**
 * Launches every fragment of a group in delay order, or nothing at all. The
 * plan is first re-checked against live RAM, worker files and the target, and
 * if any exec fails, everything already started is killed.
 */
export function launchGroup(
  ns: NS,
  group: Group,
  fragments: Fragment[],
  homeReserve: number,
): { ok: true; receipts: Receipt[] } | { ok: false; reason: string } {
  const plannedAt = Date.now();
  const skew = plannedAt - group.plannedAt;
  if (LAUNCH_LEAD_MS - skew < LAUNCH_SAFETY_MS) {
    return {
      ok: false,
      reason: `planning consumed ${skew}ms of the ${LAUNCH_LEAD_MS}ms lead`,
    };
  }

  const needed = new Map<string, number>();
  for (const { host, threads, job } of fragments) {
    needed.set(host, (needed.get(host) ?? 0) + threads * job.worker.ram);
  }
  for (const [host, ram] of needed) {
    const reserve = host === "home" ? homeReserve : 0;
    const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
    if (free + 1e-9 < ram) {
      return { ok: false, reason: `${host} free RAM changed during planning` };
    }
  }
  for (const host of needed.keys()) {
    if (host === "home" || hasWorkerFiles(ns, host)) continue;
    return {
      ok: false,
      reason: `${host} worker files changed during planning`,
    };
  }

  const moved = targetMoved(ns, group);
  if (moved) return { ok: false, reason: moved };

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
      status: "running",
    });
  }

  return { ok: true, receipts };
}

/** Why the target no longer suits the group planned for it, if it doesn't. */
function targetMoved(ns: NS, group: Group): string | null {
  let actual: Phase;
  try {
    const server = ns.getServer(group.target);
    const maxMoney = server.moneyMax ?? 0;
    const security = server.hackDifficulty ?? 100;
    actual = classify({
      valid:
        server.hasAdminRights === true &&
        !server.purchasedByPlayer &&
        maxMoney > 0,
      money: server.moneyAvailable ?? 0,
      maxMoney,
      security,
      minSecurity: server.minDifficulty ?? security,
    });
  } catch {
    return `${group.target} target read failed at launch`;
  }

  const expected = READY_PHASE[group.purpose];
  if (actual === expected) return null;
  return `target state moved from ${expected} to ${actual}`;
}

/**
 * Sleeps until the next thing that could need action: a worker's expected
 * end, a settle or backoff ending, an append window opening, or the network
 * refresh. Never less than MIN_SLEEP_MS or more than MAX_SLEEP_MS.
 */
function nextWakeDelay(state: State, now: number): number {
  let wakeAt = Math.min(now + MAX_SLEEP_MS, state.nextNetworkRefresh);

  for (const receipt of state.inFlight.receipts) {
    if (isLive(receipt)) wakeAt = Math.min(wakeAt, receipt.endsAt);
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
 * launches. Every target that gets nothing gets a reason.
 */
export function decide(
  targets: Target[],
  inFlight: InFlight,
  ctx: PlanContext,
): Decision {
  const reasons: Reason[] = [];

  const candidates: Array<{ target: Target; window: AppendWindow | null }> = [];
  for (const target of targets) {
    const window = appendWindow(target, inFlight);
    if (window) {
      if (ctx.now >= window.launchAt) candidates.push({ target, window });
      else reasons.push({ host: target.host, code: "ALL_TARGETS_BUSY" });
      continue;
    }

    const blocked = ineligibleReason(target, inFlight);
    if (blocked) {
      reasons.push({ host: target.host, code: blocked });
      continue;
    }
    if (target.phase !== "BATCH_READY") continue;
    if (!target.economics?.batch || target.economics.moneyPerSecond <= 0) {
      reasons.push({ host: target.host, code: "NO_PROFITABLE_BATCH" });
      continue;
    }
    candidates.push({ target, window: null });
  }
  candidates.sort(
    (a, b) =>
      (b.target.economics?.moneyPerSecond ?? 0) -
        (a.target.economics?.moneyPerSecond ?? 0) ||
      compareText(a.target.host, b.target.host),
  );

  let runners = ctx.runners;
  let holding = false;
  let waitingBatchUnits: number | null = null;
  for (const { target, window } of candidates) {
    const batch = target.economics?.batch;
    if (!batch) continue;

    const wave = planWave(target, batch, window, { ...ctx, runners });
    if (wave.ok && window && !readsPrepped(target)) {
      reasons.push({ host: target.host, code: "RESERVED_FOR_BATCH_WINDOW" });
      runners = withoutFragments(runners, wave.fragments);
      holding = true;
      continue;
    }
    if (wave.ok) {
      const { group, fragments } = wave;
      return { kind: "batch", target, group, fragments, reasons };
    }
    // Held RAM is spoken for only until the next batch cycle, so a wave it
    // crowds out isn't counted as too large (that would shrink its batches).
    const code = window || holding ? "RESERVED_FOR_BATCH_WINDOW" : wave.code;
    reasons.push({ host: target.host, code });
    waitingBatchUnits ??= wave.requiredUnits;
  }

  const prepCtx = { ...ctx, runners };
  const freeUnits = runners.reduce((sum, runner) => sum + runner.units, 0);
  const prepTargets = targets
    .filter(
      (target) =>
        isPrepPhase(target.phase) &&
        ineligibleReason(target, inFlight) === null,
    )
    .sort(prepOrder(ctx.now));
  for (const target of prepTargets) {
    const prep = planPrep(target, prepCtx);
    if (!prep.ok) {
      reasons.push({ host: target.host, code: prep.code });
      continue;
    }
    const { group, fragments } = prep;
    if (!leavesBatchWindow(group, waitingBatchUnits, inFlight, freeUnits)) {
      reasons.push({ host: target.host, code: "RESERVED_FOR_BATCH_WINDOW" });
      continue;
    }
    return { kind: "prep", target, group, fragments, reasons };
  }

  const dominant = dominantReason(reasons, targets.length);
  return { kind: "idle", dominantReason: dominant, reasons };
}

/** Why a target can't take a new group right now, or null if it can. */
export function ineligibleReason(
  target: Target,
  inFlight: InFlight,
): ReasonCode | null {
  const { phase } = target;
  const busy =
    target.activeGroupId !== null || hasLiveReceipts(inFlight, target.host);

  if (busy || phase === "PREP_IN_FLIGHT" || phase === "BATCH_IN_FLIGHT")
    return "ALL_TARGETS_BUSY";
  if (phase === "SETTLING") return "ALL_TARGETS_BUSY";
  // closeFinishedGroups() ends a backoff at the start of a loop.
  if (phase === "BACKOFF") return "LAUNCH_BACKOFF";
  if (phase === "NEEDS_OBSERVATION" || target.observation === null)
    return "WAITING_FOR_OBSERVATION";
  if (phase === "UNAVAILABLE") return "NO_ELIGIBLE_TARGETS";
  return null;
}

/**
 * When the next wave can launch behind a target's running batch chain, timed
 * so its first hack lands one gap after the chain's last landing. Null when
 * the chain can't take more: nothing of it is left in flight, or a worker
 * went late or was lost.
 */
export function appendWindow(
  target: Target,
  inFlight: InFlight,
): AppendWindow | null {
  const batch = target.economics?.batch;
  const groupId = target.activeGroupId;
  if (target.phase !== "BATCH_IN_FLIGHT" || !batch) return null;
  if (groupId === null || groupId === "recovered") return null;

  const faults = inFlight.faults.get(groupId);
  if (faults && (faults.lost > 0 || faults.late > 0)) return null;

  const live = inFlight.receipts.filter(
    (r) => r.groupId === groupId && r.target === target.host && isLive(r),
  );
  if (live.length === 0) return null;

  const lastEndAt = Math.max(...live.map((receipt) => receipt.endsAt));
  return {
    lastEndAt,
    launchAt: lastEndAt + LANDING_GAP_MS - LAUNCH_LEAD_MS - batch.weakenTime,
  };
}

/**
 * Prep queue order. Targets that have waited PREP_AGING_MS go first, so a
 * rich newcomer can't starve them; then prep priority, then longest waiting.
 */
function prepOrder(now: number): (a: Target, b: Target) => number {
  const aged = (target: Target): number =>
    now - target.waitingSince >= PREP_AGING_MS ? 1 : 0;
  const priority = (target: Target): number =>
    target.economics?.prepPriority ?? 0;

  return (a, b) =>
    aged(b) - aged(a) ||
    priority(b) - priority(a) ||
    a.waitingSince - b.waitingSince ||
    compareText(a.host, b.host);
}

/**
 * Whether a prep group leaves room for the batch waiting on RAM. It doesn't
 * when in-flight work will free enough for that batch at a known time and the
 * prep would still be holding too much RAM then.
 */
export function leavesBatchWindow(
  prep: Group,
  waitingBatchUnits: number | null,
  inFlight: InFlight,
  freeUnits: number,
): boolean {
  if (waitingBatchUnits === null) return true;

  const shortfall = waitingBatchUnits - freeUnits;
  if (shortfall <= 0) return true;

  const windowStart = earliestReleaseTime(inFlight, shortfall);
  if (windowStart === null) return true;

  // Prep that has given its RAM back before the window can't delay anything.
  if (prep.lastEndAt <= windowStart) return true;

  const releasedByThen = inFlight.receipts
    .filter((receipt) => isLive(receipt) && receipt.endsAt <= windowStart)
    .reduce((sum, receipt) => sum + receipt.units, 0);
  const freeAtWindow = freeUnits + releasedByThen - requiredUnits(prep.jobs);
  return freeAtWindow >= waitingBatchUnits;
}

/** When enough in-flight RAM will be back to cover `units`, or null if never. */
export function earliestReleaseTime(
  inFlight: InFlight,
  units: number,
): number | null {
  const live = inFlight.receipts
    .filter(isLive)
    .sort((a, b) => a.endsAt - b.endsAt);

  let released = 0;
  for (const receipt of live) {
    released += receipt.units;
    if (released >= units) return receipt.endsAt;
  }
  return null;
}

/** The most common reason; ties go to the alphabetically first. */
function dominantReason(reasons: Reason[], targetCount: number): ReasonCode {
  if (targetCount === 0 || reasons.length === 0) return "NO_ELIGIBLE_TARGETS";

  const counts = new Map<ReasonCode, number>();
  for (const { code } of reasons) counts.set(code, (counts.get(code) ?? 0) + 1);

  let best: ReasonCode = "NO_ELIGIBLE_TARGETS";
  let bestCount = -1;
  for (const [code, count] of counts) {
    if (count > bestCount || (count === bestCount && code < best)) {
      best = code;
      bestCount = count;
    }
  }
  return best;
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
  const noPlan: Placement = {
    ok: false,
    code: "PREP_GROUP_TOO_LARGE",
    requiredUnits: 0,
  };
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
 * fits is complete. When nothing fits, says why a size-1 group doesn't.
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
  const invalid = jobs.some(
    ({ threads, worker }) =>
      !Number.isFinite(threads) ||
      threads < 1 ||
      !Number.isFinite(worker.ram) ||
      worker.ram <= 0,
  );
  if (invalid) {
    return {
      ok: false,
      code: "INVALID_PLAN",
      requiredUnits: requiredUnits(jobs),
    };
  }

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
    if (remaining > 0) return shortage(runners, group);
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

/** Why a group's jobs don't fit on the runners. */
function shortage(runners: Runner[], group: Group): Placement {
  const required = requiredUnits(group.jobs);
  const available = runners.reduce((sum, runner) => sum + runner.units, 0);
  const blocked = runners.reduce((sum, runner) => sum + runner.blockedUnits, 0);
  const largest = Math.max(0, ...runners.map((runner) => runner.units));
  const smallestThread = Math.min(
    ...group.jobs.map((job) => toUnits(job.worker.ram)),
  );

  let code: ReasonCode;
  if (blocked > 0 && available + blocked >= required) {
    code = "WORKERS_NOT_DEPLOYED";
  } else if (available < required) {
    code =
      group.purpose === "batch"
        ? "COMPLETE_BATCH_TOO_LARGE"
        : "PREP_GROUP_TOO_LARGE";
  } else if (largest < smallestThread) {
    code = "BELOW_SMALLEST_THREAD";
  } else {
    code = "RUNNER_FRAGMENTATION";
  }
  return { ok: false, code, requiredUnits: required };
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
    batchTooLargeCount: 0,
    batchSizeNotches: 0,
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
  target.batchTooLargeCount = 0;
  target.batchSizeNotches = 0;
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

/**
 * Expected $/s of repeated waves of this batch, each as many batches as fit
 * in `ram` up to MAX_BATCHES.
 */
function wavesMoneyPerSecond(batch: Batch, ram: number): number {
  const fit = Math.floor(ram / batch.ramNeeded);
  const batches = Math.max(1, Math.min(MAX_BATCHES, fit));
  const waveMs =
    LAUNCH_LEAD_MS +
    batch.weakenTime +
    (batches - 1) * 4 * LANDING_GAP_MS +
    3 * LANDING_GAP_MS;
  return (batch.expectedMoney * batches) / Math.max(0.001, waveMs / 1_000);
}

/** Running or late: either way it still holds its RAM. */
function isLive(receipt: Receipt): boolean {
  return receipt.status === "running" || receipt.status === "late";
}

export function hasLiveReceipts(inFlight: InFlight, host: string): boolean {
  return inFlight.receipts.some((r) => r.target === host && isLive(r));
}

/** What a worker's liveness means, given when it was expected to end. */
export function workerStatus(
  receipt: Receipt,
  running: boolean,
  now: number,
): Receipt["status"] {
  if (running) {
    return now > receipt.endsAt + LATE_TOLERANCE_MS ? "late" : "running";
  }
  return now >= receipt.endsAt - EARLY_TOLERANCE_MS ? "finished" : "lost";
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
  const live = state.inFlight.receipts.filter(isLive);
  const inFlightRam = fromUnits(live.reduce((sum, r) => sum + r.units, 0));
  const uptime = formatDuration(Date.now() - state.startedAt);

  const lines = [
    "=== MULTI-TARGET SCHEDULER ===",
    `Loop ${state.loops} | up ${uptime} | ` +
      `launched ${state.launched} | failed ${state.launchFailures}`,
    `Network: ${state.hosts.length} known | ${state.runners.length} runners | ` +
      `rooted +${state.rooted} | deployed +${state.deployed}`,
    `RAM: ${formatRam(state.capacityRam)} usable | ` +
      `${formatRam(free)} schedulable | ${formatRam(inFlightRam)} in flight | ` +
      `${formatRam(state.settings.homeReserve)} home reserve`,
    `Last launch: ${state.lastLaunch}`,
    ...targetLines(ns, state),
    ...inFlightLines(state),
    ...decisionLines(decision, free),
  ];
  // One entry, not one per line: the game keeps only the newest 50 log
  // entries by default, which cut the top off the status once there were
  // many targets.
  ns.print(lines.join("\n"));
}

function targetLines(ns: NS, state: State): string[] {
  const lines = [`--- targets (${state.targets.size}) ---`];
  const byRate = [...state.targets.values()].sort(
    (a, b) =>
      (b.economics?.moneyPerSecond ?? 0) - (a.economics?.moneyPerSecond ?? 0),
  );

  for (const { host, phase, observation, economics } of byRate) {
    const money =
      observation && observation.maxMoney > 0
        ? `${((observation.money / observation.maxMoney) * 100).toFixed(0)}%`
        : "-";
    const security = observation
      ? `${observation.security.toFixed(1)}/${observation.minSecurity.toFixed(1)}`
      : "-";
    const rate = ns.format.number(economics?.moneyPerSecond ?? 0);
    lines.push(
      `  ${host.padEnd(18)} ${phase.padEnd(19)} money ${money.padStart(4)} | ` +
        `sec ${security.padStart(11)} | $${rate}/s`,
    );
  }
  return lines;
}

function inFlightLines(state: State): string[] {
  const live = state.inFlight.receipts.filter(isLive);
  if (live.length === 0 && state.previousWorkers.length === 0) {
    return ["--- in flight: none ---"];
  }

  type Summary = {
    target: string;
    count: number;
    units: number;
    endsAt: number;
  };
  const groups = new Map<string, Summary>();
  for (const { groupId, target, units, endsAt } of live) {
    const group = groups.get(groupId) ?? { target, count: 0, units: 0, endsAt };
    group.count++;
    group.units += units;
    group.endsAt = Math.max(group.endsAt, endsAt);
    groups.set(groupId, group);
  }

  const now = Date.now();
  const lines = [
    `--- in flight: ${groups.size} group(s), ${live.length} fragment(s) ---`,
  ];
  for (const [id, group] of groups) {
    const faults = state.inFlight.faults.get(id);
    lines.push(
      `  ${id.padEnd(26)} ${group.target.padEnd(16)} ` +
        `${String(group.count).padStart(3)} frag | ` +
        `${formatRam(fromUnits(group.units)).padStart(10)} | ` +
        `ends in ${formatDuration(Math.max(0, group.endsAt - now))}` +
        (faults?.late ? ` | ${faults.late} LATE` : "") +
        (faults?.lost ? ` | ${faults.lost} LOST` : ""),
    );
  }

  const previous = state.previousWorkers.length;
  if (previous > 0) {
    lines.push(`  recovered from a previous run: ${previous} worker(s)`);
  }
  return lines;
}

function decisionLines(decision: Decision, freeRam: number): string[] {
  if (decision.kind !== "idle") {
    return [
      `--- decision: ${describeGroup(decision.group)} ---`,
      ...fragmentLines(decision.fragments),
    ];
  }

  const unallocated = formatRam(freeRam);
  const lines = [
    `--- idle: ${unallocated} unallocated (${decision.dominantReason}) ---`,
  ];
  const hostsByCode = new Map<ReasonCode, string[]>();
  for (const { host, code } of decision.reasons) {
    hostsByCode.set(code, [...(hostsByCode.get(code) ?? []), host]);
  }
  for (const [code, hosts] of hostsByCode) {
    const more = hosts.length > 4 ? ` +${hosts.length - 4} more` : "";
    lines.push(`  ${code.padEnd(26)} ${hosts.slice(0, 4).join(", ")}${more}`);
  }
  return lines;
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
