/**
 * singularity/buy-augs.ts — buys every augmentation your faction reputation
 * and money allow, most expensive first, then spends what is left on
 * NeuroFlux Governor levels, and exits
 *
 * Buying through this script instead of the Augmentations page is worth 15
 * Intelligence exp per purchase. Nothing is installed: do that yourself when
 * you are ready to reset.
 *
 * Singularity calls cost 16x RAM while Source-File 4 is at level 1, which puts
 * this script at about 418 GB (106 GB at level 2, 28 GB at level 3).
 *
 * Usage: run singularity/buy-augs.ts
 *
 * @param {NS} ns
 */
const NEUROFLUX = "NeuroFlux Governor";

/** The game's faction-name type, which is not a global the way NS is. */
type FactionName = ReturnType<NS["getPlayer"]>["factions"][number];

/** What can be bought this run, and what has been bought so far. */
interface Shop {
  /** Augmentation → a faction you are in that has the reputation to sell it. */
  sellers: Map<string, FactionName>;
  /** Installed or already purchased, including this run's purchases. */
  owned: Set<string>;
  purchases: number;
  spent: number;
}

interface Offer {
  faction: FactionName;
  price: number;
}

export async function main(ns: NS): Promise<void> {
  const shop = openShop(ns);
  const wanted = listWanted(ns, shop);

  for (const augmentation of wanted) {
    buyWithPrerequisites(ns, shop, augmentation);
  }
  buyNeuroFluxLevels(ns, shop);

  printSummary(ns, shop, wanted);
}

/** Works out who will sell you what, and what you already have. */
function openShop(ns: NS): Shop {
  return {
    sellers: findSellers(ns),
    owned: new Set(ns.singularity.getOwnedAugmentations(true)),
    purchases: 0,
    spent: 0,
  };
}

/** Maps each augmentation you have the reputation for to a faction selling it. */
function findSellers(ns: NS): Map<string, FactionName> {
  const sing = ns.singularity;
  const sellers = new Map<string, FactionName>();
  const factions = ns
    .getPlayer()
    .factions.map((name) => ({ name, reputation: sing.getFactionRep(name) }))
    // Highest reputation first: NeuroFlux's requirement rises with every
    // level, so its seller should be the faction that can keep selling longest.
    .sort((a, b) => b.reputation - a.reputation);

  for (const faction of factions) {
    for (const augmentation of sing.getAugmentationsFromFaction(faction.name)) {
      if (sellers.has(augmentation)) continue;
      if (faction.reputation < sing.getAugmentationRepReq(augmentation)) {
        continue;
      }
      sellers.set(augmentation, faction.name);
    }
  }
  return sellers;
}

/** Augmentations you can get but don't have yet, most expensive first. */
function listWanted(ns: NS, shop: Shop): string[] {
  return (
    [...shop.sellers.keys()]
      .filter((name) => name !== NEUROFLUX && !shop.owned.has(name))
      .map((name) => ({
        name,
        price: ns.singularity.getAugmentationPrice(name),
      }))
      // Every purchase multiplies the price of everything still unbought, so
      // the multiplier should pile up on the cheap ones.
      .sort((a, b) => b.price - a.price)
      .map((augmentation) => augmentation.name)
  );
}

/** Buys an augmentation, buying any prerequisite you lack just before it. */
function buyWithPrerequisites(
  ns: NS,
  shop: Shop,
  augmentation: string,
): boolean {
  if (shop.owned.has(augmentation)) return true;
  // Checked before the prerequisites: buying those out of price order only
  // pays off when this one follows.
  if (!findOffer(ns, shop, augmentation)) return false;

  const prerequisites = ns.singularity.getAugmentationPrereq(augmentation);
  for (const prerequisite of prerequisites) {
    if (!buyWithPrerequisites(ns, shop, prerequisite)) return false;
  }
  return buy(ns, shop, augmentation);
}

/** Spends what is left on NeuroFlux Governor levels. */
function buyNeuroFluxLevels(ns: NS, shop: Shop): void {
  // Each level raises both the price and the reputation requirement, so this
  // ends when either one runs out.
  while (buy(ns, shop, NEUROFLUX)) {}
}

/** Buys one augmentation and records it; false if it did not go through. */
function buy(ns: NS, shop: Shop, augmentation: string): boolean {
  const offer = findOffer(ns, shop, augmentation);
  if (!offer) return false;
  if (!ns.singularity.purchaseAugmentation(offer.faction, augmentation)) {
    return false;
  }

  shop.owned.add(augmentation);
  shop.purchases++;
  shop.spent += offer.price;
  ns.tprint(`Bought ${augmentation} for $${ns.format.number(offer.price)}.`);
  return true;
}

/** Where to buy it and for how much right now, if it is within reach. */
function findOffer(
  ns: NS,
  shop: Shop,
  augmentation: string,
): Offer | undefined {
  const faction = shop.sellers.get(augmentation);
  const price = ns.singularity.getAugmentationPrice(augmentation);

  if (faction === undefined || price > ns.getPlayer().money) return undefined;
  return { faction, price };
}

/** Prints the total, and what your reputation allowed but went unbought. */
function printSummary(ns: NS, shop: Shop, wanted: string[]): void {
  const total =
    shop.purchases === 0
      ? "Bought nothing: no augmentation is within your reputation and money."
      : `${shop.purchases} purchases for $${ns.format.number(shop.spent)} in total.`;
  ns.tprint(total);

  const missed = wanted.filter((name) => !shop.owned.has(name));
  if (missed.length === 0) return;
  ns.tprint(
    `Not bought (out of money, or a prerequisite is out of reach): ${missed.join(", ")}.`,
  );
}
