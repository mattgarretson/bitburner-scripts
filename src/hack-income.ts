/**
 * hack-income.ts — measures your hacking income for a few minutes, prints it
 * in dollars per second, then exits
 *
 * Counts money from every hack, whichever script ran it, so it works the same
 * for multi-manager.ts and batcher.ts. Start the manager, give it about five
 * minutes to prep and fill up, then run this.
 *
 * Usage: run hack-income.ts
 *
 * @param {NS} ns
 */
const MINUTES = 5;

export async function main(ns: NS): Promise<void> {
  const before = hackingMoney(ns);
  ns.tprint(`Measuring hacking income for ${MINUTES} minutes...`);

  await ns.sleep(MINUTES * 60_000);

  const perSecond = (hackingMoney(ns) - before) / (MINUTES * 60);
  ns.tprint(
    `Hacking income: $${ns.format.number(perSecond)}/s over ${MINUTES} minutes.`,
  );
}

function hackingMoney(ns: NS): number {
  return ns.getMoneySources().sinceInstall.hacking;
}
