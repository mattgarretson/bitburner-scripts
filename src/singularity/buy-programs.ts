/**
 * singularity/buy-programs.ts — buys TOR, then every darkweb program as soon as
 * it is affordable, cheapest first, and exits once everything is owned
 *
 * Cheapest-first means the port crackers (BruteSSH → SQLInject) land well before
 * Formulas.exe. Leave it running from the start of a run; it spends money the
 * moment a program becomes affordable.
 *
 * Usage: run singularity/buy-programs.ts
 *
 * @param {NS} ns
 */
const POLL_MS = 10_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const sing = ns.singularity;

  while (!sing.purchaseTor()) {
    ns.print("Waiting for money to buy TOR...");
    await ns.sleep(POLL_MS);
  }

  while (true) {
    const missing = sing
      .getDarkwebPrograms()
      .map((name) => ({ name, cost: sing.getDarkwebProgramCost(name) }))
      .filter((program) => program.cost > 0)
      .sort((a, b) => a.cost - b.cost);

    if (missing.length === 0) {
      ns.tprint("All darkweb programs owned.");
      return;
    }

    for (const { name, cost } of missing) {
      if (cost > ns.getServerMoneyAvailable("home")) break;
      if (sing.purchaseProgram(name)) {
        ns.tprint(`Bought ${name} for $${ns.format.number(cost)}.`);
      }
    }

    const next = missing.find((p) => sing.getDarkwebProgramCost(p.name) > 0);
    if (next) {
      ns.print(`Next: ${next.name} at $${ns.format.number(next.cost)}`);
    }
    await ns.sleep(POLL_MS);
  }
}
