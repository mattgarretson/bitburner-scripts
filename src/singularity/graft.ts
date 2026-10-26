/**
 * singularity/graft.ts — starts grafting the one augmentation you name, then
 * exits; the graft carries on as your current work without the script
 *
 * You must already be in New Tokyo: travelling from a script would add 32 GB
 * while Source-File 4 is at level 1, so that is left to you. Refuses to start
 * while another graft is running, because starting one cancels the other and
 * the money is not refunded. Starting any other work, workout.ts included,
 * cancels the graft the same way.
 *
 * Grafts unfocused, which is 20% slower unless you have Neuroreceptor
 * Management Implant. The name must be exact, capitals included. If the game
 * refuses, its reason is printed; "Invalid aug" means you already have it
 * (installed or bought) or it can't be grafted.
 *
 * About 9.6 GB. There are no Singularity calls, so the Source-File 4 level
 * doesn't matter.
 *
 * Usage: run singularity/graft.ts SPTN-97 Gene Modification
 *
 * @param {NS} ns
 */
const GRAFT_CITY = "New Tokyo";
const FOCUS = false;

export async function main(ns: NS): Promise<void> {
  const augmentation = augmentationFromArgs(ns);
  requireGraftCity(ns);
  await requireNoGraftRunning(ns);

  startGraft(ns, augmentation);
  ns.tprint(`Started grafting ${augmentation}.`);
}

/** The augmentation name: every argument joined, since names contain spaces. */
function augmentationFromArgs(ns: NS): string {
  const augmentation = ns.args.join(" ");
  if (augmentation === "") {
    fail(ns, "Usage: run singularity/graft.ts <augmentation name>");
  }
  return augmentation;
}

/** Ends the script unless you are in the one city where grafting works. */
function requireGraftCity(ns: NS): void {
  if (ns.getPlayer().city === GRAFT_CITY) return;
  fail(ns, `Travel to ${GRAFT_CITY} first: grafting only works there.`);
}

/** Ends the script if a graft is already running. */
async function requireNoGraftRunning(ns: NS): Promise<void> {
  if (!(await isGraftRunning(ns))) return;
  fail(
    ns,
    "A graft is already running. Starting another would cancel it, " +
      "and its cost is not refunded.",
  );
}

/**
 * True while a graft is running. Built on waitForOngoingGrafting(), which is
 * free, rather than getCurrentWork(), which costs 8 GB at SF4 level 1.
 */
async function isGraftRunning(ns: NS): Promise<boolean> {
  let settled = false;
  // Settles at once unless a graft is running: it resolves when you are idle
  // and rejects when your current work is something else.
  ns.grafting.waitForOngoingGrafting().then(
    () => (settled = true),
    () => (settled = true),
  );
  // A zero-length sleep is a timer, so every promise callback runs before it.
  await ns.sleep(0);
  return !settled;
}

/** Starts the graft, or ends the script with the game's reason for refusing. */
function startGraft(ns: NS, augmentation: string): void {
  let started: boolean;
  try {
    started = ns.grafting.graftAugmentation(augmentation, FOCUS);
  } catch {
    // The game throws, rather than returning false, for a name it doesn't know.
    fail(ns, `"${augmentation}" is not an augmentation name. Check spelling.`);
  }
  if (started) return;

  // Every refusal is logged as one line just before false is returned.
  const reason = ns.getScriptLogs().at(-1) ?? "no reason given";
  fail(ns, `Did not start grafting ${augmentation}: ${reason}`);
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}
