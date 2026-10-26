/**
 * batcher.ts — keeps hack/weaken/grow/weaken batches landing on every server
 * you can hack, best earners per GB of RAM first, for as long as it runs
 *
 * Each target is first prepped: weakened to minimum security and grown to max
 * money. Then it gets a new batch every 4 x GAP_MS, timed so the batch's hack,
 * weaken, grow and weaken land GAP_MS apart. A batch only launches while the
 * target reads prepped, because the game fixes how long each operation takes
 * from the target's security when the operation starts. A target that drifts
 * off prepped gets no new batches, and once its last one lands it is prepped
 * again.
 *
 * Uses the RAM of every server you have root on, home last and less
 * HOME_RESERVE_GB. A batch that doesn't fit steals less, so HACK_FRACTION is
 * only the most one batch takes. When RAM runs out, the targets that earn
 * least per GB of RAM wait.
 *
 * Run stop-hacking.ts first if multi-manager.ts or another batcher is running:
 * two schedulers on the same targets knock each other's batches out of line.
 *
 * Usage: run batcher.ts
 *
 * @param {NS} ns
 */
import {
  buildPreparedBatch,
  deployWorkers,
  loadWorkers,
  rootAvailableServers,
  scanNetwork,
} from "./hacking-lib.ts";
import type { Config, Workers } from "./hacking-lib.ts";

/** Most of a target's max money one batch steals; less when RAM is short. */
const HACK_FRACTION = 0.5;
/** Milliseconds between the four landings of one batch. */
const GAP_MS = 200;
const HOME_RESERVE_GB = 8;
/** Head start on every launch, so slow exec calls can't make anything land late. */
const LEAD_MS = 1_000;
/** Extra grow threads, so a hack that takes a bit more after a level-up is still regrown. */
const GROW_MARGIN = 1.1;
const LOOP_MS = 50;
const REFRESH_MS = 10_000;

/**
 * How far ahead of its slot a batch may be queued: two batches. Once batches
 * are landing, a target reads prepped for only one gap in four, so waiting
 * for each slot's exact moment would leave holes in the stream.
 */
const QUEUE_AHEAD_MS = 8 * GAP_MS;

/** One full-size batch, in the terms buildPreparedBatch sizes it in. */
const FULL_BATCH: Config = {
  hackFraction: HACK_FRACTION,
  minimumHackFraction: HACK_FRACTION,
  growSafetyMargin: GROW_MARGIN - 1,
};

type Operation = keyof Workers;
type Status = "waiting" | "prepping" | "batching" | "no RAM";

/** One worker launch: what it does, how many threads, and how long it waits first. */
type Job = {
  operation: Operation;
  label: string;
  threads: number;
  delay: number;
};

type Placement = { host: string; threads: number };

type Target = {
  host: string;
  status: Status;
  /** When the last operation launched against it lands. */
  lastLandingAt: number;
  /** When each batch still in flight lands its final weaken. */
  batchEnds: number[];
};

type Run = {
  workers: Workers;
  startedAt: number;
  hackingMoneyAtStart: number;
  deployedHosts: Set<string>;
  /** Rooted servers with RAM to run workers on. */
  runners: string[];
  /** Best earners per GB first, which is the order they get RAM in. */
  targets: Target[];
  nextRefreshAt: number;
  launches: number;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const workers = loadWorkers(ns);
  if (!workers) return;
  const run = startRun(ns, workers);

  while (true) {
    if (Date.now() >= run.nextRefreshAt) refreshNetwork(ns, run);

    const free = readFreeRam(ns, run.runners);
    for (const target of run.targets) feedTarget(ns, run, free, target);

    renderStatus(ns, run, free);
    await ns.sleep(LOOP_MS);
  }
}

function startRun(ns: NS, workers: Workers): Run {
  return {
    workers,
    startedAt: Date.now(),
    hackingMoneyAtStart: hackingMoney(ns),
    deployedHosts: new Set(),
    runners: [],
    targets: [],
    nextRefreshAt: 0,
    launches: 0,
  };
}

/** Roots what it can, copies the workers out, and picks up new targets. */
function refreshNetwork(ns: NS, run: Run): void {
  const hosts = scanNetwork(ns);
  rootAvailableServers(ns, hosts);
  deployWorkers(ns, hosts, run.deployedHosts);

  run.runners = hosts.filter(
    (host) => ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0,
  );
  addNewTargets(ns, run, hosts);
  rankByEarningsPerGb(ns, run);
  run.nextRefreshAt = Date.now() + REFRESH_MS;
}

/** Adds servers that just became hackable. */
function addNewTargets(ns: NS, run: Run, hosts: string[]): void {
  const known = new Set(run.targets.map((target) => target.host));

  for (const host of hosts) {
    if (known.has(host) || !isHackable(ns, host)) continue;
    run.targets.push({
      host,
      status: "waiting",
      lastLandingAt: 0,
      batchEnds: [],
    });
  }
}

/**
 * Orders targets by what a full batch earns per GB-second of RAM, redone each
 * refresh because it shifts as your hacking level rises. A batch holds its
 * RAM for the whole weaken time, so a rich target that is slow, or close to
 * your level and so steals little per thread, can be worth far less RAM than
 * a smaller one.
 */
function rankByEarningsPerGb(ns: NS, run: Run): void {
  const earnings = new Map(
    run.targets.map((target) => [
      target.host,
      earningsPerGbSecond(ns, run.workers, target.host),
    ]),
  );
  run.targets.sort(
    (a, b) => (earnings.get(b.host) ?? 0) - (earnings.get(a.host) ?? 0),
  );
}

/** Expected dollars per GB-second of a full batch, at minimum security. */
function earningsPerGbSecond(ns: NS, workers: Workers, host: string): number {
  const batch = buildPreparedBatch(ns, host, workers, FULL_BATCH, Infinity);
  if (!batch) return 0;
  return batch.expectedMoney / (batch.ramNeeded * (batch.weakenTime + LEAD_MS));
}

function isHackable(ns: NS, host: string): boolean {
  return (
    ns.hasRootAccess(host) &&
    ns.getServerMaxMoney(host) > 0 &&
    ns.getServerRequiredHackingLevel(host) <= ns.getHackingLevel()
  );
}

/** Free RAM on every runner, with home's reserve already taken off. */
function readFreeRam(ns: NS, runners: string[]): Map<string, number> {
  const free = new Map<string, number>();
  for (const host of runners) {
    const reserve = host === "home" ? HOME_RESERVE_GB : 0;
    const ram = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve;
    free.set(host, Math.max(0, ram));
  }
  return free;
}

/** Starts whatever the target is ready for: a prep, more batches, or nothing yet. */
function feedTarget(
  ns: NS,
  run: Run,
  free: Map<string, number>,
  target: Target,
): void {
  const now = Date.now();
  target.batchEnds = target.batchEnds.filter((end) => end > now);

  if (!isPrepped(ns, target.host)) {
    // Normal between batch landings. Prep only once everything has landed,
    // with a gap of slack because landings can run a little late.
    if (now < target.lastLandingAt + GAP_MS) return;
    target.status = launchPrep(ns, run, free, target, now)
      ? "prepping"
      : "no RAM";
    return;
  }

  const queueUntil =
    now + ns.getWeakenTime(target.host) + LEAD_MS + QUEUE_AHEAD_MS;
  while (target.lastLandingAt + GAP_MS <= queueUntil) {
    if (!launchBatch(ns, run, free, target, now)) {
      target.status = "no RAM";
      return;
    }
    target.status = "batching";
  }
}

/** True at minimum security and (all but) max money. */
function isPrepped(ns: NS, host: string): boolean {
  return (
    ns.getServerSecurityLevel(host) <=
      ns.getServerMinSecurityLevel(host) + 0.001 &&
    ns.getServerMoneyAvailable(host) >= ns.getServerMaxMoney(host) * 0.999
  );
}

/**
 * Weakens the target to minimum security and grows it to max money: weaken,
 * grow, and the grow's weaken land in that order. If the whole prep doesn't
 * fit it is halved until it does, since a partial prep still gets closer.
 */
function launchPrep(
  ns: NS,
  run: Run,
  free: Map<string, number>,
  target: Target,
  now: number,
): boolean {
  const host = target.host;
  const extraSecurity =
    ns.getServerSecurityLevel(host) - ns.getServerMinSecurityLevel(host);
  const weakenThreads = Math.ceil(extraSecurity / ns.weakenAnalyze(1));
  const growMultiplier =
    ns.getServerMaxMoney(host) / Math.max(1, ns.getServerMoneyAvailable(host));
  const growThreads = Math.ceil(
    ns.growthAnalyze(host, growMultiplier) * GROW_MARGIN,
  );
  const landAt = now + ns.getWeakenTime(host) + LEAD_MS;

  for (let share = 1; share >= 1 / 64; share /= 2) {
    const jobs = prepJobs(
      ns,
      host,
      landAt,
      now,
      Math.ceil(weakenThreads * share),
      Math.ceil(growThreads * share),
    );
    if (!launchJobs(ns, run, free, host, jobs, now)) continue;

    target.lastLandingAt = landAt + 2 * GAP_MS;
    return true;
  }
  return false;
}

/** The prep's jobs, leaving out any part with no threads. */
function prepJobs(
  ns: NS,
  host: string,
  landAt: number,
  now: number,
  weakenThreads: number,
  growThreads: number,
): Job[] {
  const weakenTime = ns.getWeakenTime(host);
  const jobs: Job[] = [
    {
      operation: "weaken",
      label: "PW1",
      threads: weakenThreads,
      delay: landAt - weakenTime - now,
    },
    {
      operation: "grow",
      label: "PG",
      threads: growThreads,
      delay: landAt + GAP_MS - ns.getGrowTime(host) - now,
    },
    {
      operation: "weaken",
      label: "PW2",
      threads: weakenForGrow(ns, growThreads),
      delay: landAt + 2 * GAP_MS - weakenTime - now,
    },
  ];
  return jobs.filter((job) => job.threads > 0);
}

/**
 * Queues one batch in the next free slot after the target's last landing.
 * If a batch stealing HACK_FRACTION doesn't fit, its hack threads are halved
 * until it does, down to one.
 */
function launchBatch(
  ns: NS,
  run: Run,
  free: Map<string, number>,
  target: Target,
  now: number,
): boolean {
  const landAt = Math.max(
    target.lastLandingAt + GAP_MS,
    now + ns.getWeakenTime(target.host) + LEAD_MS,
  );
  const fullThreads = Math.floor(HACK_FRACTION / ns.hackAnalyze(target.host));

  for (let threads = Math.max(1, fullThreads); threads >= 1; threads >>= 1) {
    const jobs = batchJobs(ns, target.host, landAt, now, threads);
    if (!launchJobs(ns, run, free, target.host, jobs, now)) continue;

    target.lastLandingAt = landAt + 3 * GAP_MS;
    target.batchEnds.push(target.lastLandingAt);
    return true;
  }
  return false;
}

/**
 * One batch whose hack lands at `landAt`. Sized from the target's live
 * numbers, which are its prepped numbers because batches only launch then.
 */
function batchJobs(
  ns: NS,
  host: string,
  landAt: number,
  now: number,
  hackThreads: number,
): Job[] {
  const hackPercent = ns.hackAnalyze(host);
  const regrowth = 1 / (1 - hackThreads * hackPercent);
  const growThreads = Math.ceil(ns.growthAnalyze(host, regrowth) * GROW_MARGIN);
  const weakenTime = ns.getWeakenTime(host);

  return [
    {
      operation: "hack",
      label: "H",
      threads: hackThreads,
      delay: landAt - ns.getHackTime(host) - now,
    },
    {
      operation: "weaken",
      label: "W1",
      threads: weakenForHack(ns, hackThreads),
      delay: landAt + GAP_MS - weakenTime - now,
    },
    {
      operation: "grow",
      label: "G",
      threads: growThreads,
      delay: landAt + 2 * GAP_MS - ns.getGrowTime(host) - now,
    },
    {
      operation: "weaken",
      label: "W2",
      threads: weakenForGrow(ns, growThreads),
      delay: landAt + 3 * GAP_MS - weakenTime - now,
    },
  ];
}

/** Weaken threads that undo the security added by `hackThreads` hacks. */
function weakenForHack(ns: NS, hackThreads: number): number {
  return Math.ceil(ns.hackAnalyzeSecurity(hackThreads) / ns.weakenAnalyze(1));
}

/** Weaken threads that undo the security added by `growThreads` grows. */
function weakenForGrow(ns: NS, growThreads: number): number {
  // No hostname: with one, the game caps the answer at what the target's
  // current money needs, which is nothing on a prepped target.
  return Math.ceil(ns.growthAnalyzeSecurity(growThreads) / ns.weakenAnalyze(1));
}

/**
 * Places and starts every job together, all timed from `plannedAt`; the
 * workers subtract however late they start. False if the jobs don't all fit
 * or a launch fails, and then nothing from this call is left running.
 */
function launchJobs(
  ns: NS,
  run: Run,
  free: Map<string, number>,
  target: string,
  jobs: Job[],
  plannedAt: number,
): boolean {
  const placements = placeJobs(free, run.workers, jobs);
  if (!placements) return false;

  const tag = `bt-${run.launches++}`;
  const pids: number[] = [];
  for (const [index, job] of jobs.entries()) {
    for (const { host, threads } of placements[index]) {
      const pid = ns.exec(
        run.workers[job.operation].file,
        host,
        { threads, temporary: true },
        target,
        job.delay,
        plannedAt,
        tag,
        job.label,
      );
      if (pid === 0) {
        for (const started of pids) ns.kill(started);
        return false;
      }
      pids.push(pid);
    }
  }
  return true;
}

/**
 * Finds room for every thread of every job and takes that RAM out of `free`.
 * Returns where each job's threads go, or null, leaving `free` untouched, if
 * anything doesn't fit.
 */
function placeJobs(
  free: Map<string, number>,
  workers: Workers,
  jobs: Job[],
): Placement[][] | null {
  const trial = new Map(free);
  const placements: Placement[][] = [];

  for (const job of jobs) {
    const parts = placeThreads(trial, job.threads, workers[job.operation].ram);
    if (!parts) return null;
    placements.push(parts);
  }

  for (const [host, ram] of trial) free.set(host, ram);
  return placements;
}

/** Spreads threads over the servers with the most free RAM, home last. */
function placeThreads(
  free: Map<string, number>,
  threads: number,
  ramPerThread: number,
): Placement[] | null {
  const parts: Placement[] = [];
  let remaining = threads;

  for (const host of hostsByFreeRam(free)) {
    if (remaining === 0) break;
    const ram = free.get(host) ?? 0;
    const fit = Math.min(remaining, Math.floor(ram / ramPerThread));
    if (fit < 1) continue;

    parts.push({ host, threads: fit });
    free.set(host, ram - fit * ramPerThread);
    remaining -= fit;
  }
  return remaining === 0 ? parts : null;
}

/** Most free RAM first, with home last so it stays free for your own scripts. */
function hostsByFreeRam(free: Map<string, number>): string[] {
  const others = [...free.keys()].filter((host) => host !== "home");
  others.sort((a, b) => (free.get(b) ?? 0) - (free.get(a) ?? 0));
  return free.has("home") ? [...others, "home"] : others;
}

/** Prints the status as one log entry, since the log keeps only the newest 50. */
function renderStatus(ns: NS, run: Run, free: Map<string, number>): void {
  const now = Date.now();
  const totalRam = run.runners.reduce(
    (sum, host) => sum + ns.getServerMaxRam(host),
    0,
  );
  const freeRam = [...free.values()].reduce((sum, ram) => sum + ram, 0);

  const lines = [
    `=== batcher | up ${formatDuration(now - run.startedAt)} | ` +
      `hacking $${ns.format.number(hackingIncome(ns, run))}/s since start ===`,
    `RAM: ${ns.format.ram(freeRam)} free of ${ns.format.ram(totalRam)} | ` +
      `hack up to ${ns.format.percent(HACK_FRACTION, 0)} per batch | ` +
      `${run.targets.length} targets`,
    ...run.targets.map((target) => describeTarget(target, now)),
  ];
  ns.clearLog();
  ns.print(lines.join("\n"));
}

/** One status line: the host, what it is doing, and how far along. */
function describeTarget(target: Target, now: number): string {
  const line = `  ${target.host.padEnd(20)} ${target.status.padEnd(9)}`;
  if (target.status === "prepping") {
    return `${line} ready in ${formatDuration(target.lastLandingAt - now)}`;
  }
  if (target.batchEnds.length > 0) {
    return `${line} ${target.batchEnds.length} batches in flight`;
  }
  return line;
}

/** Hacking dollars per second since this script started, from all hacks. */
function hackingIncome(ns: NS, run: Run): number {
  const seconds = Math.max(1, (Date.now() - run.startedAt) / 1_000);
  return (hackingMoney(ns) - run.hackingMoneyAtStart) / seconds;
}

function hackingMoney(ns: NS): number {
  return ns.getMoneySources().sinceInstall.hacking;
}

/** "45s" or "2m05s". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}
