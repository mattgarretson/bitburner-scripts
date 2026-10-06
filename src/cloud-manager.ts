/**
 * cloud-manager.ts — buys and upgrades cloud servers until every slot is at the
 * RAM limit, then exits
 *
 * Each step considers buying a new server and upgrading each existing one, each
 * sized to the largest power of two the budget allows, and takes the option with
 * the lowest cost per added GB. Where price is proportional to RAM (most
 * BitNodes) those tie, and the one adding the most RAM wins.
 *
 * Usage: run cloud-manager.ts
 */

/** Share of current cash one step may spend. */
const SPEND_FRACTION = 0.2;
/** Cash that is never spent. */
const CASH_RESERVE = 5_000_000;
/** Smallest server worth buying, in GB. */
const MIN_RAM = 8;
const NAME_PREFIX = "pserv";

type Step = {
  label: string;
  cost: number;
  addedRam: number;
  act: () => boolean;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const ceiling = ns.cloud.getRamLimit();
  let lastWaiting = "";

  while (true) {
    const servers = ns.cloud.getServerNames();
    const slotsLeft = ns.cloud.getServerLimit() - servers.length;

    if (
      slotsLeft <= 0 &&
      servers.every((host) => ns.getServerMaxRam(host) >= ceiling)
    ) {
      ns.tprint(
        `cloud-manager: all ${servers.length} servers are at ` +
          `${ns.format.ram(ceiling)}. Nothing left to buy.`,
      );
      return;
    }

    const cash = ns.getServerMoneyAvailable("home");
    const budget = Math.max(
      0,
      Math.min(cash * SPEND_FRACTION, cash - CASH_RESERVE),
    );

    const step = bestStep(ns, ceiling, servers, slotsLeft, budget);

    if (!step) {
      const waiting = describeNextStep(ns, ceiling, servers, slotsLeft);
      if (waiting !== lastWaiting) {
        ns.print(`waiting: ${waiting} | budget $${ns.format.number(budget)}`);
        lastWaiting = waiting;
      }
      await ns.sleep(5_000);
      continue;
    }

    lastWaiting = "";
    if (step.act()) {
      ns.print(
        `${step.label} | $${ns.format.number(step.cost)} | ` +
          `$${ns.format.number(step.cost / step.addedRam)}/GB`,
      );
      await ns.sleep(100);
    } else {
      ns.print(`FAILED: ${step.label} | $${ns.format.number(step.cost)}`);
      await ns.sleep(5_000);
    }
  }
}

/**
 * The affordable step with the lowest cost per added GB; ties go to the step
 * adding the most RAM, so linear pricing makes the largest jump.
 */
function bestStep(
  ns: NS,
  ceiling: number,
  servers: string[],
  slotsLeft: number,
  budget: number,
): Step | null {
  const steps: Step[] = [];

  if (slotsLeft > 0) {
    const buy = largestAffordable(MIN_RAM, ceiling, budget, (ram) =>
      ns.cloud.getServerCost(ram),
    );
    if (buy) {
      const name = nextName(servers);
      steps.push({
        label: `buy ${name} at ${ns.format.ram(buy.ram)}`,
        cost: buy.cost,
        addedRam: buy.ram,
        act: () => ns.cloud.purchaseServer(name, buy.ram) !== "",
      });
    }
  }

  for (const host of servers) {
    const current = ns.getServerMaxRam(host);
    if (current >= ceiling) continue;

    const upgrade = largestAffordable(current * 2, ceiling, budget, (ram) =>
      ns.cloud.getServerUpgradeCost(host, ram),
    );
    if (upgrade) {
      steps.push({
        label: `upgrade ${host}: ${ns.format.ram(current)} -> ${ns.format.ram(upgrade.ram)}`,
        cost: upgrade.cost,
        addedRam: upgrade.ram - current,
        act: () => ns.cloud.upgradeServer(host, upgrade.ram),
      });
    }
  }

  steps.sort((a, b) => {
    const perGb = a.cost / a.addedRam - b.cost / b.addedRam;
    const tied = Math.abs(perGb) <= 1e-9 * Math.max(a.cost, b.cost);
    return tied ? b.addedRam - a.addedRam : perGb;
  });
  return steps[0] ?? null;
}

/** Largest power-of-two RAM in [lowest, highest] whose cost fits the budget. */
function largestAffordable(
  lowest: number,
  highest: number,
  budget: number,
  costOf: (ram: number) => number,
): { ram: number; cost: number } | null {
  for (let ram = highest; ram >= lowest; ram /= 2) {
    const cost = costOf(ram);
    if (Number.isFinite(cost) && cost > 0 && cost <= budget) {
      return { ram, cost };
    }
  }
  return null;
}

/** The cheapest possible next step, for the waiting message. */
function describeNextStep(
  ns: NS,
  ceiling: number,
  servers: string[],
  slotsLeft: number,
): string {
  const options: { label: string; cost: number }[] = [];

  if (slotsLeft > 0) {
    options.push({
      label: `new ${ns.format.ram(MIN_RAM)} server`,
      cost: ns.cloud.getServerCost(MIN_RAM),
    });
  }
  for (const host of servers) {
    const current = ns.getServerMaxRam(host);
    if (current >= ceiling) continue;
    options.push({
      label: `${host} ${ns.format.ram(current)} -> ${ns.format.ram(current * 2)}`,
      cost: ns.cloud.getServerUpgradeCost(host, current * 2),
    });
  }

  const cheapest = options
    .filter((option) => Number.isFinite(option.cost) && option.cost > 0)
    .sort((a, b) => a.cost - b.cost)[0];

  return cheapest
    ? `${cheapest.label} costs $${ns.format.number(cheapest.cost)}`
    : "no valid step";
}

function nextName(existing: string[]): string {
  const used = new Set(existing);
  for (let i = 0; ; i++) {
    const name = `${NAME_PREFIX}-${String(i).padStart(2, "0")}`;
    if (!used.has(name)) return name;
  }
}
