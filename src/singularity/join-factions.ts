/**
 * singularity/join-factions.ts — accepts every faction invitation you have
 * waiting, except from city factions, then exits
 *
 * Joining through this script instead of the Factions page is worth 7.5
 * Intelligence exp per faction. City factions are left for you to join by
 * hand, because joining one shuts you out of its rivals until the next reset.
 *
 * joinFaction() is the only Singularity call, which keeps the script at about
 * 50 GB while Source-File 4 is at level 1.
 *
 * Usage: run singularity/join-factions.ts
 *
 * @param {NS} ns
 */

/** The game's faction-name type, which is not a global the way NS is. */
type FactionName = ReturnType<NS["getPlayer"]>["factions"][number];

/** The only factions with enemies: each one bans you from some of the others. */
const CITY_FACTIONS = new Set<FactionName>([
  "Sector-12",
  "Aevum",
  "Chongqing",
  "New Tokyo",
  "Ishima",
  "Volhaven",
]);

export async function main(ns: NS): Promise<void> {
  const joined = acceptInvitations(ns);

  if (joined.length === 0) {
    ns.tprint("No faction joined: no invitation waiting outside the cities.");
    return;
  }
  ns.tprint(`Joined ${joined.join(", ")}.`);
}

/** Joins every non-city faction that has invited you, and returns their names. */
function acceptInvitations(ns: NS): FactionName[] {
  const joined: FactionName[] = [];

  for (const faction of Object.values(ns.enums.FactionName)) {
    if (CITY_FACTIONS.has(faction)) continue;
    // False unless an invitation is waiting, so trying every faction saves
    // paying for checkFactionInvitations() as well.
    if (ns.singularity.joinFaction(faction)) joined.push(faction);
  }
  return joined;
}
