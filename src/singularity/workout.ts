/**
 * singularity/workout.ts — trains strength, defense, dexterity and agility to
 * a target level each at Powerhouse Gym, one stat at a time, then stops working
 * out and exits
 *
 * The target is the first argument, or 200 without one. Travels to Sector-12
 * first if you are somewhere else ($200k). Stats already at the target are
 * skipped, so it is safe to re-run after an interruption.
 *
 * Usage:
 *   run singularity/workout.ts         trains each stat to 200
 *   run singularity/workout.ts 75      trains each stat to 75
 *
 * @param {NS} ns
 */
const DEFAULT_TARGET_LEVEL = 200;
const GYM = "Powerhouse Gym";
const GYM_CITY = "Sector-12";
const FOCUS = false;
const POLL_MS = 1_000;

/** Trained in this order. `gymCode` is what the gym API calls the stat. */
const STATS = [
  { name: "strength", gymCode: "str" },
  { name: "defense", gymCode: "def" },
  { name: "dexterity", gymCode: "dex" },
  { name: "agility", gymCode: "agi" },
] as const;
type Stat = (typeof STATS)[number];

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");

  const targetLevel = targetLevelFromArgs(ns);

  for (const stat of STATS) {
    if (levelOf(ns, stat) >= targetLevel) continue;

    await trainToTarget(ns, stat, targetLevel);
    ns.tprint(`${stat.name} reached ${targetLevel}.`);
  }

  ns.tprint(`All combat stats are at ${targetLevel}+.`);
}

/** The level to train to: the first argument, or the default without one. */
function targetLevelFromArgs(ns: NS): number {
  if (ns.args.length === 0) return DEFAULT_TARGET_LEVEL;

  const level = ns.args[0];
  // Written as !(>= 1) so that NaN is refused along with zero and negatives.
  if (typeof level !== "number" || !(level >= 1)) {
    fail(
      ns,
      `Usage: run singularity/workout.ts [target level] ` +
        `(default ${DEFAULT_TARGET_LEVEL})`,
    );
  }
  return level;
}

/** Works out one stat until it reaches the target, then ends the workout. */
async function trainToTarget(
  ns: NS,
  stat: Stat,
  targetLevel: number,
): Promise<void> {
  while (levelOf(ns, stat) < targetLevel) {
    // gymWorkout() cancels and restarts the task on every call, so only start
    // one when it is not already running: at first, or after an interruption.
    if (!isWorkingOut(ns, stat)) startWorkout(ns, stat);

    ns.print(`Training ${stat.name}: ${levelOf(ns, stat)}/${targetLevel}`);
    await ns.sleep(POLL_MS);
  }

  if (isWorkingOut(ns, stat)) ns.singularity.stopAction();
}

/** Travels to the gym's city if needed and starts the workout there. */
function startWorkout(ns: NS, stat: Stat): void {
  const sing = ns.singularity;

  if (ns.getPlayer().city !== GYM_CITY && !sing.travelToCity(GYM_CITY)) {
    fail(ns, `Could not travel to ${GYM_CITY} — not enough money?`);
  }
  if (!sing.gymWorkout(GYM, stat.gymCode, FOCUS)) {
    fail(ns, `Could not start ${stat.name} training at ${GYM}.`);
  }
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}

/** True when the player's current task is this exact workout. */
function isWorkingOut(ns: NS, stat: Stat): boolean {
  const work = ns.singularity.getCurrentWork();
  return (
    work?.type === "CLASS" &&
    work.location === GYM &&
    work.classType === stat.gymCode
  );
}

function levelOf(ns: NS, stat: Stat): number {
  return ns.getPlayer().skills[stat.name];
}
