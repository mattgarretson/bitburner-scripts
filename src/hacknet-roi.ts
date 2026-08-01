/**
 * hacknet-roi.ts — buys the Hacknet Node upgrade with the shortest payback
 *
 * This is for money-producing Hacknet Nodes, not BN9 hash-producing servers.
 * It compares cost / added production instead of blindly buying the cheapest
 * button.
 *
 * Usage:
 *   run hacknet-roi.ts
 *   run hacknet-roi.ts 0.10 1000000 3600 12
 *
 * Args:
 *   0: maximum fraction of current cash for one purchase  default 0.10
 *   1: absolute cash reserve                            default $1m
 *   2: maximum accepted payback time in seconds        default 1 hour
 *   3: maximum node count                              default 12
 *
 * @param {NS} ns
 */
type HacknetCandidate = {
  label: string;
  cost: number;
  gain: number;
  act: () => boolean;
};

type HacknetNodeStats = ReturnType<NS["hacknet"]["getNodeStats"]>;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const purchaseFraction = clamp(Number(ns.args[0] ?? 0.1), 0, 1);
  const cashReserve = Math.max(0, Number(ns.args[1] ?? 1_000_000));
  const maxPayback = Math.max(1, Number(ns.args[2] ?? 3600));
  const maxNodes = Math.max(0, Math.floor(Number(ns.args[3] ?? 12)));

  const reset = ns.getResetInfo();
  if (reset.currentNode === 9 || reset.ownedSF.has(9)) {
    ns.tprint(
      "ERROR: Hacknet is in hash-server mode; use a hash-spending manager instead.",
    );
    return;
  }

  while (true) {
    const nodes = ns.hacknet.numNodes();

    if (nodes > 0 && ns.hacknet.getNodeStats(0).hashCapacity !== undefined) {
      ns.tprint(
        "ERROR: hacknet-roi.ts is for money Hacknet Nodes, not hash servers.",
      );
      return;
    }

    const candidates: HacknetCandidate[] = [];
    const globalProductionMult =
      nodes > 0
        ? inferGlobalProductionMultiplier(ns.hacknet.getNodeStats(0))
        : null;

    if (nodes < Math.min(maxNodes, ns.hacknet.maxNumNodes())) {
      const cost = ns.hacknet.getPurchaseNodeCost();
      const gain =
        globalProductionMult === null ? 1.5 : 1.5 * globalProductionMult;
      candidates.push({
        label: `buy node ${nodes}`,
        cost,
        gain,
        act: () => ns.hacknet.purchaseNode() !== -1,
      });
    }

    for (let i = 0; i < nodes; i++) {
      const stats = ns.hacknet.getNodeStats(i);

      const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
      candidates.push({
        label: `node ${i} level ${stats.level} -> ${stats.level + 1}`,
        cost: levelCost,
        gain: stats.production / stats.level,
        act: () => ns.hacknet.upgradeLevel(i, 1),
      });

      const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
      candidates.push({
        label: `node ${i} RAM ${stats.ram} -> ${stats.ram * 2}`,
        cost: ramCost,
        gain: stats.production * (Math.pow(1.035, stats.ram) - 1),
        act: () => ns.hacknet.upgradeRam(i, 1),
      });

      const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
      candidates.push({
        label: `node ${i} cores ${stats.cores} -> ${stats.cores + 1}`,
        cost: coreCost,
        gain: stats.production / (stats.cores + 5),
        act: () => ns.hacknet.upgradeCore(i, 1),
      });
    }

    const best = candidates
      .filter(
        (c) =>
          Number.isFinite(c.cost) &&
          c.cost > 0 &&
          Number.isFinite(c.gain) &&
          c.gain > 0,
      )
      .map((c) => ({ ...c, payback: c.cost / c.gain }))
      .sort((a, b) => a.payback - b.payback)[0];

    if (!best) {
      await ns.sleep(5000);
      continue;
    }

    const cash = ns.getServerMoneyAvailable("home");
    const spendable = Math.max(
      0,
      Math.min(cash * purchaseFraction, cash - cashReserve),
    );

    if (best.cost <= spendable && best.payback <= maxPayback) {
      if (best.act()) {
        ns.print(
          `${best.label} | cost ${ns.format.number(best.cost)} | ` +
            `+${ns.format.number(best.gain)}/s | payback ${ns.format.time(best.payback * 1000)}`,
        );
      }
      await ns.sleep(200);
    } else {
      await ns.sleep(5000);
    }
  }
}

/** @param {ReturnType<NS["hacknet"]["getNodeStats"]>} stats */
function inferGlobalProductionMultiplier(stats: HacknetNodeStats): number {
  const base =
    1.5 *
    stats.level *
    Math.pow(1.035, stats.ram - 1) *
    ((stats.cores + 5) / 6);
  return stats.production / base;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
