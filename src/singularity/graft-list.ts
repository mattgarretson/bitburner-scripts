/**
 * singularity/graft-list.ts — grafts every augmentation on the list you name,
 * one after another, skipping any you already have, then exits
 *
 * Leave the game open: scripts stop when it is closed. A graft that is running
 * when this starts is waited out first; any other work makes it refuse to
 * start rather than cancel that work. A graft the game refuses (not enough
 * money, a missing prerequisite) is reported and skipped. If a graft is
 * cancelled, for example by starting workout.ts, the whole list stops, since
 * the game keeps the money. Travelling during a graft is fine.
 *
 * Usage: run singularity/graft-list.ts combat
 *
 * @param {NS} ns
 */
const GRAFT_CITY = "New Tokyo";
const FOCUS = false;

/**
 * Grafted top to bottom, and prerequisites come before what needs them.
 * "Combat" means all four combat stats.
 */
const GRAFT_LISTS = {
  combat: [
    "SPTN-97 Gene Modification", // combat x1.75, hacking x1.15
    "Bionic Spine", // combat x1.15
    "Graphene Bionic Spine Upgrade", // combat x1.6
    "Bionic Arms", // str, dex x1.3
    "Graphene Bionic Arms Upgrade", // str, dex x1.85
    "Bionic Legs", // agi x1.6
    "Graphene Bionic Legs Upgrade", // agi x2.5
    "NEMEAN Subdermal Weave", // def x2.2
    "Graphene Bone Lacings", // str, def x1.7
    "Augmented Targeting I", // dex x1.1
    "Augmented Targeting II", // dex x1.2
    "Augmented Targeting III", // dex x1.3
    "CordiARC Fusion Reactor", // combat x1.35, combat exp x1.35
    "HyperSight Corneal Implant", // dex x1.4
    "Photosynthetic Cells", // str, def, agi x1.4
    "Synthetic Heart", // str, agi x1.5
    "Neotra", // str, def x1.55
    "nextSENS Gene Modification", // combat x1.2, hacking x1.2
    "Xanipher", // combat x1.2, hacking x1.2, all exp x1.15
    "Hydroflame Left Arm", // str x2.8
  ],
  money: [
    // "ECorp HVMind Implant", // grow x3
    "Embedded Netburner Module Direct Memory Access Upgrade", // money x1.4
    "DataJack", // money x1.25
    "Embedded Netburner Module Core V2 Upgrade", // money x1.3, hacking x1.08
    "Embedded Netburner Module Core V3 Upgrade", // money x1.4, hacking x1.1
  ],
} as const;

export async function main(ns: NS): Promise<void> {
  const list = chosenList(ns);
  await finishCurrentGraft(ns);

  for (const augmentation of listGraftsToDo(ns, list)) {
    goToGraftCity(ns);
    if (!startGraft(ns, augmentation)) continue;
    await waitForGraft(ns, augmentation);
  }
  ns.tprint("Reached the end of the graft list.");
}

/**
 * The list named by the only argument, or else every argument as an
 * augmentation name; ends the script if there are no arguments.
 */
function chosenList(ns: NS): readonly string[] {
  const name = String(ns.args[0]);
  if (ns.args.length === 1 && Object.hasOwn(GRAFT_LISTS, name)) {
    return GRAFT_LISTS[name as keyof typeof GRAFT_LISTS];
  }
  if (ns.args.length > 0) return ns.args.map(String);

  const names = Object.keys(GRAFT_LISTS).join(" or ");
  fail(
    ns,
    `Usage: run singularity/graft-list.ts <list>, where <list> is ${names}, ` +
      'or run singularity/graft-list.ts "<augmentation>" "<augmentation>" ...',
  );
}

/** Waits for a graft started before this script; refuses other work. */
async function finishCurrentGraft(ns: NS): Promise<void> {
  try {
    await ns.grafting.waitForOngoingGrafting();
  } catch {
    // It rejects at once when your current work is not a graft.
    fail(ns, "Stop your current work first: starting a graft would cancel it.");
  }
}

/** The list minus what you already have, which is printed once. */
function listGraftsToDo(ns: NS, list: readonly string[]): string[] {
  const graftable = new Set(ns.grafting.getGraftableAugmentations());
  const toDo = list.filter((name) => graftable.has(name));
  const skipped = list.filter((name) => !graftable.has(name));

  if (skipped.length > 0) {
    ns.tprint(
      `Already have, can't graft, or not an exact name: ${skipped.join(", ")}.`,
    );
  }
  return toDo;
}

/** Travels to New Tokyo, the one city where grafting works, unless there. */
function goToGraftCity(ns: NS): void {
  if (ns.getPlayer().city !== GRAFT_CITY)
    ns.singularity.travelToCity(GRAFT_CITY);
}

/** Starts the graft; false, with the game's reason printed, if refused. */
function startGraft(ns: NS, augmentation: string): boolean {
  if (ns.grafting.graftAugmentation(augmentation, FOCUS)) return true;

  // Every refusal is logged as one line just before false is returned.
  const reason = ns.getScriptLogs().at(-1) ?? "no reason given";
  ns.tprint(`Skipped ${augmentation}: ${reason}`);
  return false;
}

/** Waits for the graft to end; ends the script if it was cancelled. */
async function waitForGraft(ns: NS, augmentation: string): Promise<void> {
  // Resolves on cancellation too, so whether it finished is checked below.
  await ns.grafting.waitForOngoingGrafting();

  const finished = !ns.grafting
    .getGraftableAugmentations()
    .includes(augmentation);
  if (finished) {
    ns.tprint(`Grafted ${augmentation}.`);
    return;
  }
  fail(
    ns,
    `Grafting ${augmentation} was cancelled by other work, so the list ` +
      "stopped. The game does not refund its cost.",
  );
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}
