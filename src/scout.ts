/**
 * scout.ts — target report using the exact same batch model as manager.ts
 *
 * Usage:
 *   run scout.ts
 *   run scout.ts --limit 20 --hack 0.10 --reserve 8 --batches 20
 *
 * @param {NS} ns
 */

import {
  describeBatch,
  formatRam,
  getNetworkStats,
  getRunners,
  loadWorkers,
  rankTargets,
  rootAvailableServers,
  scanNetwork,
} from "./hacking-lib.ts";

/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const flags = ns.flags([
    ["limit", 20],
    ["hack", 0.1],
    ["reserve", 8],
    ["gap", 200],
    ["batches", 20],
    ["lead", 1_000],
  ]);

  const positional = Array.isArray(flags._) ? flags._ : [];
  if (positional.length > 0) flags.limit = positional[0];

  const config = {
    hackFraction: clamp(Number(flags.hack), 0.0025, 0.5),
    minimumHackFraction: 0.0025,
    homeReserve: Math.max(0, Number(flags.reserve) || 0),
    landingGap: Math.max(100, Math.floor(Number(flags.gap) || 200)),
    maxBatches: Math.max(1, Math.floor(Number(flags.batches) || 20)),
    launchLead: Math.max(250, Math.floor(Number(flags.lead) || 1_000)),
  };

  const workers = loadWorkers(ns);
  if (!workers) return;

  const hosts = scanNetwork(ns);
  rootAvailableServers(ns, hosts);

  const runners = getRunners(ns, hosts, config.homeReserve);
  const network = getNetworkStats(ns, hosts, runners, config.homeReserve);
  const rankings = rankTargets(ns, hosts, workers, config, network.freeRam);
  const limit = Math.max(1, Math.floor(Number(flags.limit) || 20));

  ns.tprint(
    `\n=== manager-compatible targets | ${formatRam(network.freeRam)} free | ` +
      `hack <= ${ns.format.percent(config.hackFraction)} ===`,
  );
  ns.tprint(
    "host                 expected/s  wave  chance    steal   batch RAM   threads H/W/G/W",
  );

  for (const row of rankings.slice(0, limit)) {
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
}

/**
 * @param {NS} ns
 * @param {number} dollarsPerSecond
 */
function moneyRate(ns: NS, dollarsPerSecond: number): string {
  return `$${ns.format.number(dollarsPerSecond)}/s`;
}

/**
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 */
function clamp(value: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}
