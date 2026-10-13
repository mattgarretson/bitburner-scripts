/**
 * singularity/buy-aug.ts — buys the one augmentation you name, from whichever
 * of your factions will sell it, and nothing else
 *
 * Worth 15 Intelligence exp, like any augmentation bought by script. The name
 * must be exact, capitals included. Quotes are only needed when it contains an
 * apostrophe. If the purchase is refused, the game's own reasons are printed.
 *
 * purchaseAugmentation() is the only Singularity call, which keeps the script
 * at about 82 GB while Source-File 4 is at level 1.
 *
 * Usage: run singularity/buy-aug.ts NeuroFlux Governor
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const augmentation = ns.args.join(" ");
  if (augmentation === "") {
    ns.tprint("Usage: run singularity/buy-aug.ts <augmentation name>");
    return;
  }

  const seller = ns
    .getPlayer()
    .factions.find((faction) => buyFrom(ns, faction, augmentation));
  if (seller === undefined) {
    printRefusals(ns, augmentation);
    return;
  }

  ns.tprint(`Bought ${augmentation} from ${seller}.`);
}

/** Tries to buy it from one faction; false when that faction refuses. */
function buyFrom(
  ns: NS,
  faction: ReturnType<NS["getPlayer"]>["factions"][number],
  augmentation: string,
): boolean {
  try {
    return ns.singularity.purchaseAugmentation(faction, augmentation);
  } catch {
    // The game throws, rather than returning false, for a name it doesn't know.
    fail(ns, `"${augmentation}" is not an augmentation name. Check spelling.`);
  }
}

/** Prints why each faction said no, as the game logged it. */
function printRefusals(ns: NS, augmentation: string): void {
  // Every refusal is one log line. Factions that simply don't stock it are
  // noise next to the one that turned you down over money or reputation.
  const reasons = ns
    .getScriptLogs()
    .filter((line) => !line.includes("does not have"));

  if (reasons.length === 0) {
    ns.tprint(`Did not buy ${augmentation}: none of your factions sells it.`);
    return;
  }
  ns.tprint(`Did not buy ${augmentation}:`);
  for (const reason of new Set(reasons)) ns.tprint(`  ${reason}`);
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}
