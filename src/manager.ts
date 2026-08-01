/**
 * manager.ts — readable distributed HGW manager for Bitburner 3.0.2
 *
 * The loop is intentionally boring:
 *   1. Refresh network infrastructure.
 *   2. Select the best target for the RAM we actually have.
 *   3. Weaken it to minimum security.
 *   4. Grow it to maximum money.
 *   5. Launch the largest complete batch wave that fits.
 *
 * Start:
 *   run manager.ts --hack 0.10 --reserve 8 --batches 20
 *
 * Inspect target rankings without starting the manager:
 *   run manager.ts --report
 */

import {
  allocateJobs,
  buildPreparedBatch,
  clamp,
  deployWorkers,
  describeBatch,
  formatRam,
  getNetworkStats,
  getRunners,
  inspectTarget,
  launchAtomic,
  loadWorkers,
  makeSecurityPrepJob,
  planLargestWave,
  planMoneyPrep,
  rankTargets,
  rootAvailableServers,
  scanNetwork,
  totalThreadCapacity,
  waveDuration,
} from "./hacking-lib.ts";

import type {
  LaunchResult,
  NetworkStats,
  RankingRow,
  ReadyTarget,
  TargetInfo,
  Workers,
} from "./hacking-lib.ts";

type ManagerConfig = {
  help: boolean;
  report: boolean;
  target: string;
  hackFraction: number;
  minimumHackFraction: number;
  homeReserve: number;
  landingGap: number;
  maxBatches: number;
  retargetMs: number;
  switchRatio: number;
  launchLead: number;
  infrastructureMs: number;
  securityTolerance: number;
  moneyReadyRatio: number;
  completionBuffer: number;
  statusTargetCount: number;
};

type ManagerState = {
  hosts: string[];
  deployedHosts: Set<string>;
  target: string | null;
  rankings: RankingRow[];
  nextInfrastructureRefresh: number;
  nextTargetCheck: number;
  serial: number;
  action: string;
  detail: string;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const config = readConfig(ns);
  if (config.help) return printHelp(ns);

  const workers = loadWorkers(ns);
  if (!workers) return;

  const state: ManagerState = {
    hosts: ["home"],
    deployedHosts: new Set(),
    target: config.target === "auto" ? null : config.target,
    rankings: [],
    nextInfrastructureRefresh: 0,
    nextTargetCheck: 0,
    serial: 0,
    action: "Starting",
    detail: "Scanning the network",
  };

  refreshInfrastructure(ns, config, state);

  if (config.report) {
    const runners = getRunners(ns, state.hosts, config.homeReserve);
    const network = getNetworkStats(ns, state.hosts, runners, config.homeReserve);
    const rankings = rankTargets(
      ns,
      state.hosts,
      workers,
      config,
      network.freeRam,
    );
    printTargetReport(ns, rankings, config, network);
    return;
  }

  while (true) {
    if (Date.now() >= state.nextInfrastructureRefresh) {
      refreshInfrastructure(ns, config, state);
    }

    const runners = getRunners(ns, state.hosts, config.homeReserve);
    const network = getNetworkStats(ns, state.hosts, runners, config.homeReserve);

    if (shouldCheckTarget(config, state)) {
      updateTarget(ns, config, state, workers, network.freeRam);
    }

    if (!state.target) {
      state.action = "Waiting";
      state.detail = "No rooted, hackable money target fits one complete batch";
      showStatus(ns, config, state, network, null);
      await ns.sleep(2_000);
      continue;
    }

    const target = inspectTarget(ns, state.target);
    if (!target.valid) {
      state.action = "Target unavailable";
      state.detail = target.reason;
      showStatus(ns, config, state, network, target);

      if (config.target === "auto") {
        state.target = null;
        state.nextTargetCheck = 0;
      }

      await ns.sleep(2_000);
      continue;
    }

    if (target.security > target.minSecurity + config.securityTolerance) {
      await prepareSecurity(ns, config, state, workers, network, target);
      continue;
    }

    if (target.money < target.maxMoney * config.moneyReadyRatio) {
      await prepareMoney(ns, config, state, workers, network, target);
      continue;
    }

    await launchBatchWave(ns, config, state, workers, network, target);
  }
}

// -----------------------------------------------------------------------------
// Main phases
// -----------------------------------------------------------------------------

function refreshInfrastructure(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
): void {
  state.hosts = scanNetwork(ns);
  const rooted = rootAvailableServers(ns, state.hosts);
  const copied = deployWorkers(ns, state.hosts, state.deployedHosts);

  state.nextInfrastructureRefresh = Date.now() + config.infrastructureMs;

  if (rooted > 0 || copied > 0) {
    state.action = "Infrastructure refreshed";
    state.detail = `rooted ${rooted}, deployed workers to ${copied}`;
    state.nextTargetCheck = 0;
  }
}

function shouldCheckTarget(
  config: ManagerConfig,
  state: ManagerState,
): boolean {
  if (config.target !== "auto") return state.rankings.length === 0;
  return !state.target || Date.now() >= state.nextTargetCheck;
}

function updateTarget(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
  workers: Workers,
  availableRam: number,
): void {
  const rankings = rankTargets(ns, state.hosts, workers, config, availableRam);
  state.rankings = rankings.slice(0, config.statusTargetCount);
  state.nextTargetCheck = Date.now() + config.retargetMs;

  if (config.target !== "auto") {
    state.target = config.target;
    return;
  }

  const best = rankings[0];
  if (!best) {
    state.target = null;
    return;
  }

  const current = rankings.find((row) => row.host === state.target);
  const shouldSwitch =
    !current ||
    best.host === state.target ||
    best.score >= current.score * config.switchRatio;

  if (!shouldSwitch) return;

  const oldTarget = state.target;
  state.target = best.host;
  state.action = oldTarget ? "Target switched" : "Target selected";
  state.detail = oldTarget
    ? `${oldTarget} -> ${best.host}` +
      (current
        ? ` (${ns.format.percent(best.score / current.score - 1)} better)`
        : "")
    : `${best.host} at ${moneyRate(ns, best.expectedPerSecond)}`;
}

async function prepareSecurity(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
  workers: Workers,
  network: NetworkStats,
  target: ReadyTarget,
): Promise<void> {
  const runners = getRunners(ns, state.hosts, config.homeReserve);
  const weakenPerThread = ns.weakenAnalyze(1, 1);
  const neededThreads = Math.ceil(
    (target.security - target.minSecurity) / weakenPerThread,
  );
  const availableThreads = totalThreadCapacity(
    ns,
    runners,
    workers.weaken.ram,
    config.homeReserve,
  );
  const threads = Math.min(neededThreads, availableThreads);

  if (threads < 1) {
    state.action = "Waiting for RAM";
    state.detail = "Cannot fit one weaken thread";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  const job = makeSecurityPrepJob(
    target,
    workers,
    config,
    threads,
    `prep-w-${++state.serial}`,
  );
  const allocation = allocateJobs(ns, runners, [job], config.homeReserve);
  const plannedAt = Date.now();
  const launch: LaunchResult = allocation
    ? launchAtomic(ns, allocation, plannedAt)
    : { ok: false, pids: [] };

  if (!launch.ok) {
    state.action = "Launch failed";
    state.detail = "Security prep was rolled back";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  state.action = "Preparing security";
  state.detail = `${threads}/${neededThreads} weaken threads`;
  showStatus(ns, config, state, network, target);

  await sleepUntil(
    ns,
    plannedAt + config.launchLead + target.weakenTime + config.completionBuffer,
  );
}

async function prepareMoney(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
  workers: Workers,
  network: NetworkStats,
  target: ReadyTarget,
): Promise<void> {
  const runners = getRunners(ns, state.hosts, config.homeReserve);
  const prep = planMoneyPrep(
    ns,
    target,
    runners,
    workers,
    config,
    `prep-g-${++state.serial}`,
  );

  if (!prep) {
    state.action = "Waiting for RAM";
    state.detail = "Cannot fit grow plus its compensating weaken";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  const plannedAt = Date.now();
  const launch = launchAtomic(ns, prep.allocation, plannedAt);

  if (!launch.ok) {
    state.action = "Launch failed";
    state.detail = "Money prep was rolled back";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  state.action = "Preparing money";
  state.detail =
    `${prep.growThreads}/${prep.neededGrowThreads} grow + ` +
    `${prep.weakenThreads} weaken`;
  showStatus(ns, config, state, network, target);

  await sleepUntil(
    ns,
    plannedAt +
      config.launchLead +
      target.weakenTime +
      config.landingGap +
      config.completionBuffer,
  );
}

async function launchBatchWave(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
  workers: Workers,
  network: NetworkStats,
  target: ReadyTarget,
): Promise<void> {
  const runners = getRunners(ns, state.hosts, config.homeReserve);
  const batch = buildPreparedBatch(
    ns,
    target.host,
    workers,
    config,
    network.freeRam,
  );

  if (!batch) {
    state.action = "Waiting for RAM";
    state.detail = "Cannot fit one complete H/W/G/W batch";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  const wave = planLargestWave(
    ns,
    target,
    batch,
    runners,
    workers,
    config,
    `wave-${++state.serial}`,
  );

  if (!wave) {
    state.action = "Waiting for RAM";
    state.detail = "Batch calculation fit, but distributed allocation did not";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  const plannedAt = Date.now();
  const launch = launchAtomic(ns, wave.allocation, plannedAt);

  if (!launch.ok) {
    state.action = "Launch failed";
    state.detail = "Entire batch wave was rolled back";
    showStatus(ns, config, state, network, target);
    await ns.sleep(1_000);
    return;
  }

  const duration = waveDuration(config, batch, wave.count);
  const expectedMoney = batch.expectedMoney * wave.count;
  const expectedRate = expectedMoney / Math.max(0.001, duration / 1_000);

  state.action = "Batch wave in flight";
  state.detail =
    `${wave.count}x ${describeBatch(batch)} | ` +
    `${formatRam(batch.ramNeeded)} each | ` +
    `expected ${moneyRate(ns, expectedRate)}`;
  showStatus(ns, config, state, network, target);

  await sleepUntil(ns, plannedAt + duration + config.completionBuffer);
}

// -----------------------------------------------------------------------------
// Configuration and display
// -----------------------------------------------------------------------------

function readConfig(ns: NS): ManagerConfig {
  const flags = ns.flags([
    ["target", "auto"],
    ["hack", 0.1],
    ["reserve", 8],
    ["gap", 200],
    ["batches", 20],
    ["retarget", 30],
    ["switch", 1.05],
    ["lead", 1_000],
    ["infra", 15],
    ["report", false],
    ["help", false],
  ]);

  // Compatibility with the older command:
  // run manager.ts auto 0.10 8 200
  const positional = Array.isArray(flags._) ? flags._ : [];
  if (positional.length > 0) flags.target = positional[0];
  if (positional.length > 1) flags.hack = positional[1];
  if (positional.length > 2) flags.reserve = positional[2];
  if (positional.length > 3) flags.gap = positional[3];

  const target = String(flags.target ?? "auto");

  return {
    help: Boolean(flags.help),
    report: Boolean(flags.report),
    target: target === "auto" ? "auto" : target,
    hackFraction: clamp(Number(flags.hack), 0.0025, 0.5),
    minimumHackFraction: 0.0025,
    homeReserve: Math.max(0, Number(flags.reserve) || 0),
    landingGap: Math.max(100, Math.floor(Number(flags.gap) || 200)),
    maxBatches: Math.max(1, Math.floor(Number(flags.batches) || 20)),
    retargetMs: Math.max(5, Number(flags.retarget) || 30) * 1_000,
    switchRatio: Math.max(1, Number(flags.switch) || 1.05),
    launchLead: Math.max(250, Math.floor(Number(flags.lead) || 1_000)),
    infrastructureMs: Math.max(5, Number(flags.infra) || 15) * 1_000,
    securityTolerance: 0.02,
    moneyReadyRatio: 0.999,
    completionBuffer: 250,
    statusTargetCount: 4,
  };
}

function printHelp(ns: NS): void {
  ns.tprint(`
manager.ts — distributed H/W/G/W manager

Start:
  run manager.ts --hack 0.10 --reserve 8 --batches 20

Inspect its own target rankings:
  run manager.ts --report

Options:
  --target    auto or hostname         default: auto
  --hack      maximum stolen/batch     default: 0.10
  --reserve   RAM kept free on home    default: 8
  --gap       landing gap in ms        default: 200
  --batches   maximum batches/wave     default: 20
  --retarget  target check seconds     default: 30
  --switch    score ratio to switch    default: 1.05
  --lead      launch safety lead ms    default: 1000
  --infra     network refresh seconds  default: 15
  --report    print rankings and exit
  --help      show this text

Examples:
  run manager.ts --target sigma-cosmetics --hack 0.10
  run manager.ts --hack 0.15 --reserve 32 --batches 40
  run manager.ts --switch 1 --retarget 10
`);
}

function showStatus(
  ns: NS,
  config: ManagerConfig,
  state: ManagerState,
  network: NetworkStats,
  target: TargetInfo | null,
): void {
  ns.clearLog();
  ns.print("=== DISTRIBUTED HACK MANAGER ===");
  ns.print(
    `Mode: ${config.target === "auto" ? "AUTO" : "FIXED"} | ` +
      `Target: ${state.target ?? "none"} | ` +
      `Max hack: ${ns.format.percent(config.hackFraction)}`,
  );
  ns.print(
    `Network: ${network.rooted}/${network.known} rooted | ` +
      `${network.runners} runners | ` +
      `${formatRam(network.freeRam)}/${formatRam(network.usableRam)} free`,
  );

  if (target?.valid) {
    ns.print(
      `Money: ${ns.format.number(target.money)}/${ns.format.number(target.maxMoney)} ` +
        `(${ns.format.percent(target.money / target.maxMoney)})`,
    );
    ns.print(
      `Security: ${target.security.toFixed(2)}/${target.minSecurity.toFixed(2)}`,
    );
  }

  ns.print(`Action: ${state.action}`);
  ns.print(`Detail: ${state.detail}`);

  if (state.rankings.length > 0) {
    ns.print("--- target ranking (manager's actual batch model) ---");
    for (const [index, row] of state.rankings.entries()) {
      const marker = row.host === state.target ? ">" : " ";
      ns.print(
        `${marker}${index + 1}. ${row.host.padEnd(18)} ` +
          `${moneyRate(ns, row.expectedPerSecond).padStart(12)} | ` +
          `${row.batches}x ${describeBatch(row.batch)} | ` +
          `${formatRam(row.batch.ramNeeded)}`,
      );
    }
  }
}

function printTargetReport(
  ns: NS,
  rankings: RankingRow[],
  config: ManagerConfig,
  network: NetworkStats,
): void {
  ns.tprint(
    `\n=== manager target report | ${formatRam(network.freeRam)} free | ` +
      `hack <= ${ns.format.percent(config.hackFraction)} ===`,
  );
  ns.tprint(
    "host                 expected/s  wave  chance    steal   batch RAM   threads H/W/G/W",
  );

  for (const row of rankings.slice(0, 20)) {
    const batch = row.batch;
    ns.tprint(
      `${row.host.padEnd(20)} ` +
        `${moneyRate(ns, row.expectedPerSecond).padStart(11)} ` +
        `${String(row.batches).padStart(5)} ` +
        `${ns.format.percent(batch.hackChance).padStart(7)} ` +
        `${ns.format.percent(batch.actualFraction).padStart(8)} ` +
        `${formatRam(batch.ramNeeded).padStart(11)}   ` +
        describeBatch(batch),
    );
  }

  if (rankings.length === 0) {
    ns.tprint("No rooted, hackable target can fit one complete batch.");
  }
}

function moneyRate(ns: NS, dollarsPerSecond: number): string {
  return `$${ns.format.number(dollarsPerSecond)}/s`;
}

async function sleepUntil(ns: NS, timestamp: number): Promise<void> {
  await ns.sleep(Math.max(0, timestamp - Date.now()));
}
