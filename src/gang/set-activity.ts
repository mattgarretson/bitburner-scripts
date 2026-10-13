/**
 * gang/set-activity.ts — puts every gang member on the task you name
 *
 * The name must be exact, capitals included. It is checked against the game's
 * own task list, and that list is printed when the name does not match or is
 * left out.
 *
 * Meant to sit behind one Terminal alias per task you use:
 *   alias gwar="run gang/set-activity.ts Territory Warfare"
 *
 * Usage: run gang/set-activity.ts Territory Warfare
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  if (!ns.gang.inGang()) {
    ns.tprint("You are not in a gang.");
    return;
  }

  const task = ns.args.join(" ");
  if (!ns.gang.getTaskNames().includes(task)) {
    printTaskNames(ns, task);
    return;
  }

  const members = ns.gang.getMemberNames();
  const assigned = members.filter((member) =>
    ns.gang.setMemberTask(member, task),
  );
  ns.tprint(
    `${assigned.length} of ${members.length} gang members set to ${task}.`,
  );
}

/** Prints the usage line and every task name the game accepts. */
function printTaskNames(ns: NS, task: string): void {
  if (task !== "") ns.tprint(`"${task}" is not a gang task.`);

  ns.tprint("Usage: run gang/set-activity.ts <task name>, one of:");
  for (const name of ns.gang.getTaskNames()) ns.tprint(`  ${name}`);
}
