/**
 * cloud-manager.ts — buys and upgrades cloud servers until every slot is at the
 * RAM limit, then exits
 *
 * The fleet is kept level: each step fills an empty slot with a MIN_RAM server
 * or, once every slot is taken, doubles the smallest server. An upgrade is
 * priced as the difference between the two sizes, so many small steps cost the
 * same as one big one, and a level fleet is the cheapest shape in BitNodes
 * where bigger servers cost more per GB.
 *
 * A step normally spends at most SPEND_FRACTION of current cash and never dips
 * into CASH_RESERVE. With --yolo both limits are off and every dollar you have
 * is available to each step.
 *
 * Usage:
 *   run cloud-manager.ts
 *   run cloud-manager.ts --yolo        spend everything, keep no reserve
 *
 * @param {NS} ns
 */

/** Share of current cash one step may spend. Ignored with --yolo. */
const SPEND_FRACTION = 0.2;
/** Cash that is never spent. Ignored with --yolo. */
const CASH_RESERVE = 5_000_000;
/** Size a new server is bought at, in GB. */
const MIN_RAM = 8;
const NAME_PREFIX = "pserv";

type Step = {
  label: string;
  cost: number;
  addedRam: number;
  act: () => boolean;
};

type CloudServer = {
  host: string;
  ram: number;
};

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const yolo = Boolean(ns.flags([["yolo", false]]).yolo);
  if (yolo) ns.print("--yolo: no spend cap, no cash reserve");

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
    const budget = spendingBudget(cash, yolo);

    const step = levelingStep(ns, servers, slotsLeft);

    if (step.cost > budget) {
      const waiting = `${step.label} costs $${ns.format.number(step.cost)}`;
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

/** Cash one step may spend: all of it with --yolo, else the capped share. */
function spendingBudget(cash: number, yolo: boolean): number {
  if (yolo) return cash;
  return Math.max(0, Math.min(cash * SPEND_FRACTION, cash - CASH_RESERVE));
}

/**
 * The one step that keeps the fleet level: fill an empty slot with a MIN_RAM
 * server, or with every slot taken, double the smallest server.
 */
function levelingStep(ns: NS, servers: string[], slotsLeft: number): Step {
  if (slotsLeft > 0) {
    const name = nextName(servers);
    return {
      label: `buy ${name} at ${ns.format.ram(MIN_RAM)}`,
      cost: ns.cloud.getServerCost(MIN_RAM),
      addedRam: MIN_RAM,
      act: () => ns.cloud.purchaseServer(name, MIN_RAM) !== "",
    };
  }

  const { host, ram } = smallestServer(ns, servers);
  return {
    label: `upgrade ${host}: ${ns.format.ram(ram)} -> ${ns.format.ram(ram * 2)}`,
    cost: ns.cloud.getServerUpgradeCost(host, ram * 2),
    addedRam: ram,
    act: () => ns.cloud.upgradeServer(host, ram * 2),
  };
}

/** The server with the least RAM; the first one listed wins a tie. */
function smallestServer(ns: NS, servers: string[]): CloudServer {
  return servers
    .map((host) => ({ host, ram: ns.getServerMaxRam(host) }))
    .reduce((smallest, server) =>
      server.ram < smallest.ram ? server : smallest,
    );
}

function nextName(existing: string[]): string {
  const used = new Set(existing);
  for (let i = 0; ; i++) {
    const name = `${NAME_PREFIX}-${String(i).padStart(2, "0")}`;
    if (!used.has(name)) return name;
  }
}
