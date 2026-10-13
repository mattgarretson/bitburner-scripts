/**
 * cloud-sizes.ts — prints the RAM size of every cloud server you own
 *
 * One row per server in the order the game lists them, then a summary with the
 * combined RAM and how many servers are at the RAM limit. Read-only: it buys
 * and changes nothing.
 *
 * Usage: run cloud-sizes.ts
 *
 * @param {NS} ns
 */

type CloudServer = {
  host: string;
  ram: number;
};

export async function main(ns: NS): Promise<void> {
  const servers = readCloudServers(ns);

  if (servers.length === 0) {
    ns.tprint("You have no cloud servers.");
    return;
  }

  printSizes(ns, servers);
  printSummary(ns, servers);
}

/** Every cloud server with its maximum RAM, in the game's own order. */
function readCloudServers(ns: NS): CloudServer[] {
  return ns.cloud
    .getServerNames()
    .map((host) => ({ host, ram: ns.getServerMaxRam(host) }));
}

/** Prints one aligned "name  size" row per server. */
function printSizes(ns: NS, servers: CloudServer[]): void {
  const rows = servers.map((server) => ({
    host: server.host,
    size: ns.format.ram(server.ram),
  }));
  const hostWidth = Math.max(...rows.map((row) => row.host.length));
  const sizeWidth = Math.max(...rows.map((row) => row.size.length));

  for (const row of rows) {
    ns.tprint(`${row.host.padEnd(hostWidth)}  ${row.size.padStart(sizeWidth)}`);
  }
}

/** Prints the slot count, combined RAM, and how many servers are at the limit. */
function printSummary(ns: NS, servers: CloudServer[]): void {
  const ramLimit = ns.cloud.getRamLimit();
  const atLimit = servers.filter((server) => server.ram >= ramLimit).length;
  const totalRam = servers.reduce((total, server) => total + server.ram, 0);

  ns.tprint(
    `${servers.length}/${ns.cloud.getServerLimit()} servers, ` +
      `${ns.format.ram(totalRam)} total, ` +
      `${atLimit} at the ${ns.format.ram(ramLimit)} limit`,
  );
}
