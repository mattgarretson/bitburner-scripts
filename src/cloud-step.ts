/**
 * cloud-step.ts — makes the one cloud purchase cloud-manager.ts would make
 * next, prints it, and exits
 *
 * That is a new server while a slot is empty, otherwise one doubling of the
 * smallest server. cloud-manager's per-step spending cap and cash reserve do
 * not apply here: a purchase you ask for by hand goes through whenever you can
 * pay for it. If you cannot, nothing is bought and the price is printed.
 *
 * Usage: run cloud-step.ts
 *
 * @param {NS} ns
 */
import { nextStep } from "./cloud-manager.ts";

export async function main(ns: NS): Promise<void> {
  const step = nextStep(ns);
  if (!step) {
    ns.tprint("Every cloud server is at the RAM limit. Nothing left to buy.");
    return;
  }

  const price = `$${ns.format.number(step.cost)}`;
  const cash = ns.getServerMoneyAvailable("home");
  if (step.cost > cash) {
    ns.tprint(
      `Not bought: ${step.label} costs ${price}, ` +
        `you have $${ns.format.number(cash)}.`,
    );
    return;
  }

  if (!step.act()) {
    ns.tprint(`FAILED: ${step.label} for ${price}.`);
    return;
  }
  ns.tprint(`Done: ${step.label} for ${price}.`);
}
