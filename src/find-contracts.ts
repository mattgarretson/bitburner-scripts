/**
 * find-contracts.ts — lists every coding contract on the normal network
 * Usage: run find-contracts.ts
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const hosts = ["home", ...crawl(ns)];
  let count = 0;

  for (const host of hosts) {
    for (const file of ns.ls(host, ".cct")) {
      ns.tprint(`${host.padEnd(20)} ${file}`);
      count++;
    }
  }

  if (count === 0) ns.tprint("No coding contracts found.");
  else ns.tprint(`Found ${count} coding contract(s).`);
}

/** @param {NS} ns */
function crawl(ns: NS): string[] {
  const seen = new Set<string>(["home"]);
  const stack: string[] = ["home"];
  while (stack.length) {
    const host = stack.pop();
    if (host === undefined) break;

    for (const next of ns.scan(host)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  seen.delete("home");
  return [...seen];
}
