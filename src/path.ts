/**
 * path.ts — prints a terminal connect chain to any normal network server
 * Usage: run path.ts CSEC
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const target = String(ns.args[0] ?? "");
  if (!target) {
    ns.tprint("Usage: run path.ts <server>");
    return;
  }

  const parent = new Map<string, string | null>([["home", null]]);
  const queue: string[] = ["home"];

  while (queue.length) {
    const host = queue.shift();
    if (host === undefined) break;
    if (host === target) break;
    for (const next of ns.scan(host)) {
      if (!parent.has(next)) {
        parent.set(next, host);
        queue.push(next);
      }
    }
  }

  if (!parent.has(target)) {
    ns.tprint(`No path found to ${target}.`);
    return;
  }

  const path: string[] = [];
  let host: string | null = target;
  while (host !== null) {
    path.push(host);
    host = parent.get(host) ?? null;
  }
  path.reverse();

  ns.tprint(
    path.map((host, i) => (i === 0 ? "home" : `connect ${host}`)).join("; "),
  );
}
