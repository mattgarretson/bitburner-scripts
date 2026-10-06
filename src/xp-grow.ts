/**
 * xp-grow.ts — endless grow loop used by xp-farm.ts for hacking XP
 *
 * Touches only ns.grow so each thread costs the minimum RAM.
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const target = String(ns.args[0] ?? "joesguns");
  while (true) {
    await ns.grow(target);
  }
}
