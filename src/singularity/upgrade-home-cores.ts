/**
 * singularity/upgrade-home-cores.ts — buys every home core upgrade you can
 * afford right now, then exits
 *
 * Upgrading through this script instead of a tech store is worth 3
 * Intelligence exp per core. It spends as far as your money goes and keeps
 * nothing back.
 *
 * upgradeHomeCores() is the only Singularity call, which keeps the script at
 * about 50 GB while Source-File 4 is at level 1.
 *
 * Usage: run singularity/upgrade-home-cores.ts
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const cores = buyEveryAffordableCore(ns);

  if (cores === 0) {
    ns.tprint("No home core bought: not enough money, or already maxed.");
    return;
  }
  ns.tprint(`Bought ${cores} home core(s).`);
}

/** Returns how many cores were bought. */
function buyEveryAffordableCore(ns: NS): number {
  let cores = 0;
  // False once the next one costs too much or home is at the maximum.
  while (ns.singularity.upgradeHomeCores()) cores++;
  return cores;
}
