/**
 * singularity/install-augs.ts — installs the augmentations you have bought,
 * which resets the run exactly as the Install button does
 *
 * Installing through this script is worth 15 Intelligence exp; the button is
 * worth none. It asks before resetting, and if nothing is waiting to be
 * installed it says so and changes nothing.
 *
 * installAugmentations() is the only Singularity call, which keeps the script
 * at about 82 GB while Source-File 4 is at level 1.
 *
 * Usage: run singularity/install-augs.ts
 *
 * @param {NS} ns
 */
export async function main(ns: NS): Promise<void> {
  const confirmed = await ns.prompt("Install augmentations and reset now?");
  if (!confirmed) return;

  // A real install kills every script, so this only returns when there was
  // nothing to install.
  ns.singularity.installAugmentations();
  ns.tprint("Nothing to install: no augmentation has been bought.");
}
