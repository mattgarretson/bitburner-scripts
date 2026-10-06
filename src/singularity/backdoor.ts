/**
 * singularity/backdoor.ts — roots what it can and installs a backdoor on every
 * server your hacking level allows, faction servers first, then exits once
 * every server is done
 *
 * It drives the terminal: while a backdoor installs, the terminal is connected
 * to that server, and it returns to home afterwards. w0r1d_d43m0n is always
 * skipped — backdooring it ends the BitNode.
 *
 * Imports ../hacking-lib.ts: if the game refuses to load it, that relative
 * import is the reason.
 *
 * Usage: run singularity/backdoor.ts
 *
 * @param {NS} ns
 */
import { rootAvailableServers } from "../hacking-lib.ts";

const POLL_MS = 30_000;
/** w0r1d_d43m0n ends the BitNode; darkweb is TOR's shop, not a real target. */
const NEVER = new Set(["w0r1d_d43m0n", "darkweb"]);
/** Backdoored first: each one unlocks a faction invite. */
const FACTION_SERVERS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z"];

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const failed = new Set<string>();

  while (true) {
    const parent = mapNetwork(ns);
    const hosts = [...parent.keys()];
    rootAvailableServers(ns, hosts);

    const remaining = hosts.filter((host) => {
      if (NEVER.has(host) || failed.has(host)) return false;
      const server = ns.getServer(host);
      return !server.purchasedByPlayer && !server.backdoorInstalled;
    });
    if (remaining.length === 0) {
      ns.tprint("Every server is backdoored.");
      return;
    }

    const level = ns.getHackingLevel();
    const ready = remaining
      .filter(
        (host) =>
          ns.hasRootAccess(host) &&
          ns.getServerRequiredHackingLevel(host) <= level,
      )
      .sort((a, b) => priority(ns, a) - priority(ns, b));

    for (const host of ready) {
      if (!travel(ns, parent, host)) {
        ns.tprint(`WARN: could not connect to ${host}; skipping it.`);
        failed.add(host);
        travel(ns, parent, "home");
        continue;
      }
      ns.print(`Backdooring ${host}...`);
      await ns.singularity.installBackdoor();
      ns.tprint(`Backdoored ${host}.`);
      travel(ns, parent, "home");
    }

    ns.print(`${remaining.length - ready.length} server(s) waiting on level.`);
    await ns.sleep(POLL_MS);
  }
}

/** Faction servers first (in list order), then lowest hacking level first. */
function priority(ns: NS, host: string): number {
  const faction = FACTION_SERVERS.indexOf(host);
  if (faction >= 0) return faction - FACTION_SERVERS.length;
  return ns.getServerRequiredHackingLevel(host);
}

/** BFS from home; maps every reachable host to the host it was found from. */
function mapNetwork(ns: NS): Map<string, string | null> {
  const parent = new Map<string, string | null>([["home", null]]);
  const queue = ["home"];
  while (queue.length) {
    const host = queue.shift();
    if (host === undefined) break;
    for (const next of ns.scan(host)) {
      if (parent.has(next)) continue;
      parent.set(next, host);
      queue.push(next);
    }
  }
  return parent;
}

/** Hosts from home down to `host`, inclusive. */
function pathFromHome(
  parent: Map<string, string | null>,
  host: string,
): string[] {
  const path: string[] = [];
  for (let at: string | null = host; at !== null; at = parent.get(at) ?? null) {
    path.push(at);
  }
  return path.reverse();
}

/**
 * Walks the terminal to `host` one neighbor at a time (connect() only reaches
 * neighbors): up from wherever it is now to home, then down to the target.
 */
function travel(
  ns: NS,
  parent: Map<string, string | null>,
  host: string,
): boolean {
  const sing = ns.singularity;
  const up = pathFromHome(parent, sing.getCurrentServer()).reverse().slice(1);
  const down = pathFromHome(parent, host).slice(1);
  for (const hop of [...up, ...down]) {
    if (!sing.connect(hop)) return false;
  }
  return true;
}
