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
 * With --host NAME it fills the free RAM of that one server and nothing else:
 * home and every other server are left exactly as they are. It cannot be
 * combined with --cloud, and the home RAM argument is ignored.
 *
 * Usage:
 *   run xp-farm.ts
 *   run xp-farm.ts joesguns 64            leave 64GB free on home
 *   run xp-farm.ts --cloud                home plus all but one cloud server
 *   run xp-farm.ts --cloud --keep 3       leave 3 cloud servers free
 *   run xp-farm.ts --cloud --keep 0       fill every cloud server
 *   run xp-farm.ts --host pserv-03        only pserv-03; home is left alone
 *
 * Args:
 *   0: target hostname    default joesguns
 *   1: home RAM to keep   default 0 GB
 *   --cloud               also fill cloud servers
 *   --keep N              cloud servers to leave free   default 1
 *   --host NAME           fill only this server instead of home
 *
 * @param {NS} ns
 */
const WORKER = "xp-grow.ts";

export async function main(ns: NS): Promise<void> {
  const flags = ns.flags([
    ["cloud", false],
    ["keep", 1],
    ["host", ""],
  ]);
  const keepFree = Math.max(0, Math.floor(Number(flags.keep)) || 0);
  const onlyHost = String(flags.host);
  const positional = Array.isArray(flags._) ? flags._ : [];
  const target = String(positional[0] ?? "joesguns");
  const reserve = Math.max(0, Number(positional[1] ?? 0) || 0);
  const workerRam = ns.getScriptRam(WORKER, "home");

  if (!ns.serverExists(target) || !ns.hasRootAccess(target)) {
    ns.tprint(`ERROR: no root access on "${target}".`);
    return;
  }

  if (onlyHost && flags.cloud) {
    ns.tprint("ERROR: use --host or --cloud, not both.");
    return;
  }
  // "--host home" is just the normal home run below, which also hands over
  // this script's own RAM.
  if (onlyHost && onlyHost !== "home") {
    fillSingleHost(ns, onlyHost, target, workerRam);
    return;
  }

  if (flags.cloud) {
    const hosts = ns.cloud.getServerNames();
    const fillCount = Math.max(0, hosts.length - keepFree);
    let total = 0;
    for (const [i, host] of hosts.entries()) {
      ns.scriptKill(WORKER, host);
      if (i >= fillCount) continue;
      total += startWorkers(ns, host, target, workerRam);
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

/** Restarts the worker on one named server only, touching nothing else. */
function fillSingleHost(
  ns: NS,
  host: string,
  target: string,
  workerRam: number,
): void {
  if (!ns.serverExists(host) || !ns.hasRootAccess(host)) {
    ns.tprint(`ERROR: no root access on "${host}".`);
    return;
  }

  ns.scriptKill(WORKER, host);
  const threads = startWorkers(ns, host, target, workerRam);
  if (threads < 1) {
    ns.tprint(
      `ERROR: nothing started on ${host}; one thread needs ` +
        `${ns.format.ram(workerRam)} free.`,
    );
    return;
  }

  ns.tprint(`Growing ${target} with ${threads} threads on ${host}.`);
}

/**
 * Copies the worker to a host and starts it with every thread the host's free
 * RAM fits. Returns the threads started: 0 if there was no room or the launch
 * failed.
 */
function startWorkers(
  ns: NS,
  host: string,
  target: string,
  workerRam: number,
): number {
  ns.scp(WORKER, host, "home");
  const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  const threads = Math.floor(free / workerRam);
  if (threads < 1) return 0;
  if (ns.exec(WORKER, host, threads, target) !== 0) return threads;

  ns.tprint(`WARN: failed to start ${threads} threads on ${host}.`);
  return 0;
}

/** Tab-completes hostnames and flags after `run xp-farm.ts `. */
export function autocomplete(data: { servers: string[] }): string[] {
  return [...data.servers, "--cloud", "--keep", "--host"];
}
