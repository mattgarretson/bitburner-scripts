/**
 * xp-farm.ts — fills home (and optionally every cloud server) with a grow loop
 * purely for hacking XP
 *
 * Kills any previous xp-grow.ts on the hosts it uses, then runs xp-grow.ts with
 * every thread each host can fit. Home goes last: this script spawns into it so
 * its own RAM is handed over too. Re-run it after a RAM upgrade to resize.
 *
 * With --cloud it uses all *free* RAM on cloud servers, except the last --keep
 * of them (default 1), which are left alone (any old xp-grow.ts there is still
 * killed, so they come back empty). Stop other scripts first (e.g. run
 * stop-hacking.ts) if you want the whole server.
 *
 * Usage:
 *   run xp-farm.ts
 *   run xp-farm.ts joesguns 64            leave 64GB free on home
 *   run xp-farm.ts --cloud                home plus all but one cloud server
 *   run xp-farm.ts --cloud --keep 3       leave 3 cloud servers free
 *   run xp-farm.ts --cloud --keep 0       fill every cloud server
 *
 * Args:
 *   0: target hostname    default joesguns
 *   1: home RAM to keep   default 0 GB
 *   --cloud               also fill cloud servers
 *   --keep N              cloud servers to leave free   default 1
 *
 * @param {NS} ns
 */
const WORKER = "xp-grow.ts";

export async function main(ns: NS): Promise<void> {
  const flags = ns.flags([
    ["cloud", false],
    ["keep", 1],
  ]);
  const keepFree = Math.max(0, Math.floor(Number(flags.keep)) || 0);
  const positional = Array.isArray(flags._) ? flags._ : [];
  const target = String(positional[0] ?? "joesguns");
  const reserve = Math.max(0, Number(positional[1] ?? 0) || 0);
  const workerRam = ns.getScriptRam(WORKER, "home");

  if (!ns.serverExists(target) || !ns.hasRootAccess(target)) {
    ns.tprint(`ERROR: no root access on "${target}".`);
    return;
  }

  if (flags.cloud) {
    const hosts = ns.cloud.getServerNames();
    const fillCount = Math.max(0, hosts.length - keepFree);
    let total = 0;
    for (const [i, host] of hosts.entries()) {
      ns.scriptKill(WORKER, host);
      if (i >= fillCount) continue;
      ns.scp(WORKER, host, "home");
      const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
      const threads = Math.floor(free / workerRam);
      if (threads < 1) continue;
      if (ns.exec(WORKER, host, threads, target) !== 0) total += threads;
      else ns.tprint(`WARN: failed to start ${threads} threads on ${host}.`);
    }
    const kept = hosts.slice(fillCount);
    ns.tprint(
      `Growing ${target} with ${total} threads on ${fillCount} cloud servers.` +
        (kept.length ? ` Left free: ${kept.join(", ")}.` : ""),
    );
  }

  ns.scriptKill(WORKER, "home");

  // This script's RAM is released when spawn() ends it, so count it as free.
  const free =
    ns.getServerMaxRam("home") -
    ns.getServerUsedRam("home") +
    ns.getScriptRam(ns.getScriptName()) -
    reserve;
  const threads = Math.floor(free / workerRam);
  if (threads < 1) {
    ns.tprint("ERROR: not enough free RAM on home for even one thread.");
    return;
  }

  ns.tprint(`Growing ${target} with ${threads} threads on home.`);
  ns.spawn(WORKER, { threads, spawnDelay: 100 }, target);
}

/** Tab-completes hostnames and flags after `run xp-farm.ts `. */
export function autocomplete(data: { servers: string[] }): string[] {
  return [...data.servers, "--cloud", "--keep"];
}
