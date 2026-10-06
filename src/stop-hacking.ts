/**
 * stop-hacking.ts — stops the old loop and this suite's hacking workers
 * Usage: run stop-hacking.ts
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const scripts = [
    "early-hack.ts",
    "multi-manager.ts",
    "worker-hack.ts",
    "worker-grow.ts",
    "worker-weaken.ts",
  ];

  let killed = 0;
  for (const host of ["home", ...crawl(ns)]) {
    for (const script of scripts) {
      if (script === ns.getScriptName() && host === ns.getHostname()) continue;
      if (ns.scriptKill(script, host)) killed++;
    }
  }
  ns.tprint(`Stopped ${killed} script group(s).`);
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
