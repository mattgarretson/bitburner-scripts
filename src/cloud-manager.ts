/**
 * cloud-manager.ts — buys and upgrades cloud servers in Bitburner 3.x
 *
 * Version 3 moved purchased-server APIs under ns.cloud.
 * Chooses the available purchase/upgrade with the lowest dollars per added GB.
 *
 * Usage:
 *   run cloud-manager.ts
 *   run cloud-manager.ts 0.20 5000000 8 1048576 pserv
 *
 * Args:
 *   0: max fraction of cash for one purchase  default 0.20
 *   1: absolute cash reserve                 default $5m
 *   2: minimum new-server RAM                default 8 GB
 *   3: desired RAM ceiling                   default API maximum
 *   4: hostname prefix                       default pserv
 *
 * @param {NS} ns
 */
type CloudCandidate = {
  label: string;
  cost: number;
  addedRam: number;
  act: () => string | boolean;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const purchaseFraction = clamp(Number(ns.args[0] ?? 0.2), 0, 1);
  const cashReserve = Math.max(0, Number(ns.args[1] ?? 5_000_000));
  const minRam = floorPowerOfTwo(Math.max(2, Number(ns.args[2] ?? 8)));
  const ramCeiling = Math.min(
    ns.cloud.getRamLimit(),
    floorPowerOfTwo(
      Math.max(minRam, Number(ns.args[3] ?? ns.cloud.getRamLimit())),
    ),
  );
  const prefix = String(ns.args[4] ?? "pserv");

  while (true) {
    const servers = ns.cloud.getServerNames();
    const candidates: CloudCandidate[] = [];

    if (servers.length < ns.cloud.getServerLimit()) {
      const cost = ns.cloud.getServerCost(minRam);
      candidates.push({
        label: `buy ${minRam}GB server`,
        cost,
        addedRam: minRam,
        act: () => ns.cloud.purchaseServer(nextName(servers, prefix), minRam),
      });
    }

    for (const host of servers) {
      const current = ns.getServerMaxRam(host);
      if (current >= ramCeiling) continue;
      const next = Math.min(ramCeiling, current * 2);
      const cost = ns.cloud.getServerUpgradeCost(host, next);
      candidates.push({
        label: `upgrade ${host}: ${current} -> ${next}GB`,
        cost,
        addedRam: next - current,
        act: () => ns.cloud.upgradeServer(host, next),
      });
    }

    const best = candidates
      .filter((c) => Number.isFinite(c.cost) && c.cost > 0 && c.addedRam > 0)
      .map((c) => ({ ...c, costPerGb: c.cost / c.addedRam }))
      .sort((a, b) => a.costPerGb - b.costPerGb || a.cost - b.cost)[0];

    if (!best) {
      await ns.sleep(10_000);
      continue;
    }

    const cash = ns.getServerMoneyAvailable("home");
    const spendable = Math.max(
      0,
      Math.min(cash * purchaseFraction, cash - cashReserve),
    );

    if (best.cost <= spendable) {
      const result = best.act();
      if (result !== false && result !== "") {
        ns.print(
          `${best.label} | ${ns.format.number(best.cost)} | ${ns.format.number(best.costPerGb)}/GB`,
        );
      }
      await ns.sleep(500);
    } else {
      await ns.sleep(5000);
    }
  }
}

/**
 * @param {string[]} existing
 * @param {string} prefix
 */
function nextName(existing: string[], prefix: string): string {
  const used = new Set(existing);
  for (let i = 0; ; i++) {
    const name = `${prefix}-${String(i).padStart(2, "0")}`;
    if (!used.has(name)) return name;
  }
}

/** @param {number} value */
function floorPowerOfTwo(value: number): number {
  return Math.pow(2, Math.floor(Math.log2(Math.max(1, value))));
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
