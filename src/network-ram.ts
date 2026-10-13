/**
 * network-ram.ts — prints used and free RAM on every rooted network server
 *
 * Covers the servers you have root on that are neither home nor one of your
 * cloud servers (joesguns, phantasy, ...). One row per server that has any
 * RAM, largest first, then the combined total. After that, one line per port
 * count sums the RAM on servers you have not rooted yet, which is what the
 * next port opener would add. Read-only: it changes nothing.
 *
 * Usage: run network-ram.ts
 *
 * @param {NS} ns
 */
import { scanNetwork } from "./hacking-lib.ts";

type NetworkServer = {
  host: string;
  rooted: boolean;
  portsRequired: number;
  maxRam: number;
  usedRam: number;
};

export async function main(ns: NS): Promise<void> {
  const servers = readNetworkServers(ns);
  const rooted = servers.filter((server) => server.rooted);
  const locked = servers.filter((server) => !server.rooted);

  if (rooted.length === 0) {
    ns.tprint("No rooted network server has any RAM.");
  } else {
    printUsage(ns, rooted);
    printTotal(ns, rooted);
  }
  printLockedRam(ns, locked);
}

/** Every server with RAM that is neither home nor a cloud server. */
function readNetworkServers(ns: NS): NetworkServer[] {
  const cloudServers = new Set(ns.cloud.getServerNames());

  return scanNetwork(ns)
    .filter((host) => host !== "home" && !cloudServers.has(host))
    .map((host) => ({
      host,
      rooted: ns.hasRootAccess(host),
      portsRequired: ns.getServerNumPortsRequired(host),
      maxRam: ns.getServerMaxRam(host),
      usedRam: ns.getServerUsedRam(host),
    }))
    .filter((server) => server.maxRam > 0);
}

/** Prints one aligned "name  used / size  free" row per server, largest first. */
function printUsage(ns: NS, servers: NetworkServer[]): void {
  const rows = [...servers]
    .sort((a, b) => b.maxRam - a.maxRam || a.host.localeCompare(b.host))
    .map((server) => ({
      host: server.host,
      used: ns.format.ram(server.usedRam),
      size: ns.format.ram(server.maxRam),
      free: ns.format.ram(server.maxRam - server.usedRam),
    }));
  const hostWidth = Math.max(...rows.map((row) => row.host.length));
  const usedWidth = Math.max(...rows.map((row) => row.used.length));
  const sizeWidth = Math.max(...rows.map((row) => row.size.length));
  const freeWidth = Math.max(...rows.map((row) => row.free.length));

  for (const row of rows) {
    ns.tprint(
      `${row.host.padEnd(hostWidth)}  ` +
        `${row.used.padStart(usedWidth)} / ${row.size.padStart(sizeWidth)}  ` +
        `${row.free.padStart(freeWidth)} free`,
    );
  }
}

/** Prints the server count with the combined used, total and free RAM. */
function printTotal(ns: NS, servers: NetworkServer[]): void {
  const maxRam = servers.reduce((total, server) => total + server.maxRam, 0);
  const usedRam = servers.reduce((total, server) => total + server.usedRam, 0);

  ns.tprint(
    `${countOf(servers.length, "rooted server")}: ${ns.format.ram(usedRam)} used of ` +
      `${ns.format.ram(maxRam)}, ${ns.format.ram(maxRam - usedRam)} free`,
  );
}

/** Prints, for each port count, the RAM on servers that are not rooted yet. */
function printLockedRam(ns: NS, servers: NetworkServer[]): void {
  const portCounts = [
    ...new Set(servers.map((server) => server.portsRequired)),
  ].sort((a, b) => a - b);

  for (const ports of portCounts) {
    const group = servers.filter((server) => server.portsRequired === ports);
    const maxRam = group.reduce((total, server) => total + server.maxRam, 0);

    ns.tprint(
      `not rooted, needs ${countOf(ports, "port")}: ` +
        `${countOf(group.length, "server")}, ${ns.format.ram(maxRam)}`,
    );
  }
}

/** "1 server" or "3 servers". */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
