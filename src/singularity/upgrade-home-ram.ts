/**
 * singularity/upgrade-home-ram.ts — buys every home RAM upgrade you can afford
 * right now, then exits
 *
 * Upgrading through this script instead of a tech store is worth 3
 * Intelligence exp per upgrade. It spends as far as your money goes and keeps
 * nothing back.
 *
 * upgradeHomeRam() is the only Singularity call, which keeps the script at
 * about 50 GB while Source-File 4 is at level 1.
 *
 * Usage: run singularity/upgrade-home-ram.ts
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const upgrades = buyEveryAffordableUpgrade(ns);

  if (upgrades === 0) {
    ns.tprint("Home RAM not upgraded: not enough money, or already maxed.");
    return;
  }
  const ram = ns.format.ram(ns.getServerMaxRam("home"));
  ns.tprint(`Home RAM doubled ${upgrades}x: now ${ram}.`);
}

/** Returns how many upgrades were bought. */
function buyEveryAffordableUpgrade(ns: NS): number {
  let upgrades = 0;
  // False once the next one costs too much or home is at the maximum.
  while (ns.singularity.upgradeHomeRam()) upgrades++;
  return upgrades;
}
