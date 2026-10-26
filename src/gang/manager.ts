/**
 * gang/manager.ts — runs a combat gang: recruits, trains, ascends, equips,
 * puts members to work and fights for territory, until you kill it
 *
 * A member trains until their stats are well past the point where Terrorism
 * starts paying (just below it, a member earns nothing but wanted level), then
 * works: Terrorism for respect until all 12 slots are filled, after that a
 * split between Human Trafficking for money and Terrorism. The members best at
 * Human Trafficking get its slots; Terrorism raises stats faster, so members
 * rotate between the two as they overtake each other. Working members switch
 * to Vigilante Justice while the wanted penalty is too high.
 *
 * A member ascends once their strength, defense and dexterity multipliers
 * would grow by ASCEND_AT on average.
 * Equipment is bought whenever a piece costs at most BUY_SHARE of your money,
 * augmentations first because they survive ascension.
 *
 * Until the gang holds all territory, members switch to Territory Warfare only
 * for the one update in which the game adds power (every 20 s), so power keeps
 * growing without taking anyone off their job. Clashes are engaged while the
 * win chance against every gang that still holds territory is at least
 * MIN_WIN_CHANCE. Members can die in clashes, so while clashes can happen only
 * those with FIGHTER_MIN_DEFENSE defense take part.
 *
 * It overrides tasks set by hand, so kill it before using set-activity.ts.
 *
 * Usage: run gang/manager.ts
 *
 * @param {NS} ns
 */
/** Ascend when the str/def/dex multipliers would grow by this factor on average. */
const ASCEND_AT = 1.5;
/** Buy a piece of equipment when it costs at most this share of your money. */
const BUY_SHARE = 0.01;
/**
 * A task earns no respect until a member's stats, weighted the way the task
 * weighs them, pass 4 × its difficulty, but it adds wanted level from 3.5 ×.
 * Members start work once this far past the respect line, where Terrorism's
 * wanted per respect has fallen to a few percent.
 */
const READY_MARGIN = 1.4;
/** Below this wanted penalty, working members do Vigilante Justice. */
const MIN_WANTED_PENALTY = 0.95;
/** Share of members on Human Trafficking once all 12 are recruited. */
const TRAFFICKING_SHARE = 0.5;
/**
 * A member holding a Human Trafficking slot keeps it until someone else is
 * this much better at the job, so near-equals don't trade places every update.
 */
const SWAP_MARGIN = 1.1;
/** Engage clashes when the win chance against every rival is at least this. */
const MIN_WIN_CHANCE = 0.55;
/** Defense a member needs to fight while clashes can happen. */
const FIGHTER_MIN_DEFENSE = 1000;
const MEMBER_NAME_PREFIX = "g";

const MAX_MEMBERS = 12;
const CYCLE_MS = 200;
/** The game adds territory power once every 100 cycles. */
const TERRITORY_TICK_MS = 100 * CYCLE_MS;

const TASKS = {
  respect: "Terrorism",
  money: "Human Trafficking",
  wanted: "Vigilante Justice",
  warfare: "Territory Warfare",
  training: "Train Combat",
} as const;

type Member = ReturnType<NS["gang"]["getMemberInformation"]>;
type GangInfo = ReturnType<NS["gang"]["getGangInformation"]>;
type TaskStats = ReturnType<NS["gang"]["getTaskStats"]>;

/** The two jobs members are measured against before they leave training. */
interface WorkTasks {
  respect: TaskStats;
  money: TaskStats;
}

/**
 * When the territory tick last happened. The game doesn't report it, but it is
 * the only time other gangs' power changes, so a change marks the tick.
 */
interface TickClock {
  msSinceTick: number;
  lastUpdateMs: number;
  otherPower: Record<string, number>;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  if (!ns.gang.inGang()) fail(ns, "You are not in a gang.");

  const equipment = equipmentAugmentationsFirst(ns);
  const work: WorkTasks = {
    respect: ns.gang.getTaskStats(TASKS.respect),
    money: ns.gang.getTaskStats(TASKS.money),
  };
  const clock = startClock(ns);
  const traffickers = new Set<string>();

  while (true) {
    recruitWhilePossible(ns);
    ascendAndEquip(ns, equipment);
    // Clashes first: engaging takes effect at the coming tick, so whoever is
    // chosen to fight in it must be picked knowing clashes are on.
    setClashes(ns);
    assignTasks(ns, work, traffickers, isTickDue(clock));
    printStatus(ns);

    advanceClock(ns, clock, await ns.gang.nextUpdate());
  }
}

/** Reports a problem in the terminal and ends the script. */
function fail(ns: NS, message: string): never {
  ns.tprint(message);
  ns.exit();
}

/** Every equipment name, augmentations first because they survive ascension. */
function equipmentAugmentationsFirst(ns: NS): string[] {
  const names = ns.gang.getEquipmentNames();
  return [
    ...names.filter((name) => isAugmentation(ns, name)),
    ...names.filter((name) => !isAugmentation(ns, name)),
  ];
}

function isAugmentation(ns: NS, equipment: string): boolean {
  return ns.gang.getEquipmentType(equipment) === "Augmentation";
}

/** Recruits members until the next one needs more respect than the gang has. */
function recruitWhilePossible(ns: NS): void {
  while (ns.gang.canRecruitMember()) {
    const name = unusedMemberName(ns);
    if (!ns.gang.recruitMember(name)) return;
    ns.tprint(`Gang: recruited ${name}.`);
  }
}

/** The first `gN` name nobody in the gang has, so a dead g4 is replaced by g4. */
function unusedMemberName(ns: NS): string {
  const taken = new Set(ns.gang.getMemberNames());
  let n = 1;
  while (taken.has(`${MEMBER_NAME_PREFIX}${n}`)) n++;
  return `${MEMBER_NAME_PREFIX}${n}`;
}

/** Ascends members who have grown enough, then buys what each can afford. */
function ascendAndEquip(ns: NS, equipment: string[]): void {
  for (const name of ns.gang.getMemberNames()) {
    if (isWorthAscending(ns, name)) {
      ns.gang.ascendMember(name);
      ns.tprint(`Gang: ascended ${name}.`);
    }
    buyAffordableEquipment(ns, name, equipment);
  }
}

/** True when ascending would multiply the str/def/dex multipliers by ASCEND_AT. */
function isWorthAscending(ns: NS, name: string): boolean {
  const result = ns.gang.getAscensionResult(name);
  if (result === undefined) return false;

  // Agility is left out: Terrorism gives no agility exp, so its growth would
  // hold the average down, and neither job uses agility.
  const growth = (result.str + result.def + result.dex) / 3;
  return growth >= ASCEND_AT;
}

/** Buys each piece the member lacks that costs at most BUY_SHARE of money. */
function buyAffordableEquipment(
  ns: NS,
  name: string,
  equipment: string[],
): void {
  const member = ns.gang.getMemberInformation(name);
  const owned = new Set([...member.upgrades, ...member.augmentations]);

  for (const item of equipment) {
    if (owned.has(item)) continue;
    const budget = BUY_SHARE * ns.getServerMoneyAvailable("home");
    if (ns.gang.getEquipmentCost(item) > budget) continue;

    ns.gang.purchaseEquipment(name, item);
  }
}

/** Gives every member the task chooseTask picks, changing only what differs. */
function assignTasks(
  ns: NS,
  work: WorkTasks,
  traffickers: Set<string>,
  tickDue: boolean,
): void {
  const gang = ns.gang.getGangInformation();
  const fightThisUpdate = tickDue && gang.territory < 1;
  const members = ns.gang
    .getMemberNames()
    .map((name) => ns.gang.getMemberInformation(name));
  updateTraffickers(members, work.money, traffickers);

  for (const member of members) {
    const onMoney = traffickers.has(member.name);
    const task = chooseTask(member, gang, work, fightThisUpdate, onMoney);

    if (member.task !== task) ns.gang.setMemberTask(member.name, task);
  }
}

/**
 * Hands the Human Trafficking slots, once all 12 are recruited, to the members
 * best at it, giving whoever already holds one SWAP_MARGIN of benefit.
 */
function updateTraffickers(
  members: Member[],
  money: TaskStats,
  traffickers: Set<string>,
): void {
  const slots =
    members.length >= MAX_MEMBERS
      ? Math.ceil(members.length * TRAFFICKING_SHARE)
      : 0;
  const chosen = members
    .filter((member) => isReadyFor(member, money))
    .sort(
      (a, b) =>
        traffickingRank(b, money, traffickers) -
        traffickingRank(a, money, traffickers),
    )
    .slice(0, slots);

  traffickers.clear();
  for (const member of chosen) traffickers.add(member.name);
}

/** How good the member is at Human Trafficking, plus SWAP_MARGIN if holding a slot. */
function traffickingRank(
  member: Member,
  money: TaskStats,
  traffickers: Set<string>,
): number {
  const margin = traffickers.has(member.name) ? SWAP_MARGIN : 1;
  return weightedStats(member, money) * margin;
}

/** The task this member should have for the coming update. */
function chooseTask(
  member: Member,
  gang: GangInfo,
  work: WorkTasks,
  fightThisUpdate: boolean,
  onMoney: boolean,
): string {
  if (fightThisUpdate && canFight(member, gang)) return TASKS.warfare;
  // Combat alone readies a recruit fastest: ascension (judged on combat)
  // compounds it, and Terrorism itself raises hack and charisma afterwards.
  if (!isReadyFor(member, work.respect)) return TASKS.training;
  if (isWantedTooHigh(gang)) return TASKS.wanted;
  if (onMoney) return TASKS.money;
  return TASKS.respect;
}

/** Members only die in clashes, so with none possible everyone can fight. */
function canFight(member: Member, gang: GangInfo): boolean {
  // Engaging raises the clash chance only at the next tick, and after
  // disengaging it takes 100 ticks to fall back to zero, so check both.
  const clashesPossible =
    gang.territoryWarfareEngaged || gang.territoryClashChance > 0;
  return !clashesPossible || member.def >= FIGHTER_MIN_DEFENSE;
}

/** True once the member's weighted stats are READY_MARGIN past the respect line. */
function isReadyFor(member: Member, task: TaskStats): boolean {
  return weightedStats(member, task) >= READY_MARGIN * 4 * task.difficulty;
}

/** The member's stats weighted the way the game weighs them for this task. */
function weightedStats(member: Member, task: TaskStats): number {
  return (
    (task.hackWeight * member.hack +
      task.strWeight * member.str +
      task.defWeight * member.def +
      task.dexWeight * member.dex +
      task.agiWeight * member.agi +
      task.chaWeight * member.cha) /
    100
  );
}

/** Vigilante Justice can't take wanted level below 1, so it only helps above. */
function isWantedTooHigh(gang: GangInfo): boolean {
  return gang.wantedPenalty < MIN_WANTED_PENALTY && gang.wantedLevel > 1;
}

/** Engages clashes only while every gang still holding territory is beatable. */
function setClashes(ns: NS): void {
  const gang = ns.gang.getGangInformation();
  const rivals = Object.entries(ns.gang.getAllGangInformation())
    .filter(([name, info]) => name !== gang.faction && info.territory > 0)
    .map(([name]) => name);
  const engage =
    rivals.length > 0 &&
    rivals.every(
      (rival) => ns.gang.getChanceToWinClash(rival) >= MIN_WIN_CHANCE,
    );
  if (engage === gang.territoryWarfareEngaged) return;

  ns.gang.setTerritoryWarfare(engage);
  ns.tprint(`Gang: territory clashes ${engage ? "engaged" : "disengaged"}.`);
}

/** Starts with the tick treated as due, since it can't be timed until seen. */
function startClock(ns: NS): TickClock {
  return {
    msSinceTick: TERRITORY_TICK_MS,
    lastUpdateMs: 0,
    otherPower: otherGangPower(ns),
  };
}

/** True when the coming update is expected to include the territory tick. */
function isTickDue(clock: TickClock): boolean {
  return clock.msSinceTick + clock.lastUpdateMs >= TERRITORY_TICK_MS;
}

/** Records a finished update, restarting the count if it held the tick. */
function advanceClock(ns: NS, clock: TickClock, updateMs: number): void {
  const power = otherGangPower(ns);
  const ticked = Object.keys(power).some(
    (name) => power[name] !== clock.otherPower[name],
  );

  clock.msSinceTick += updateMs;
  if (ticked) {
    // Like the game, carry the time past the tick into the next count, or a
    // long update (the game lagging) makes the next switch come too late. It
    // can't exceed this update, which also bounds the guess made at startup.
    clock.msSinceTick = Math.min(
      Math.max(clock.msSinceTick - TERRITORY_TICK_MS, 0),
      updateMs - CYCLE_MS,
    );
  }
  clock.lastUpdateMs = updateMs;
  clock.otherPower = power;
}

function otherGangPower(ns: NS): Record<string, number> {
  const own = ns.gang.getGangInformation().faction;
  const power: Record<string, number> = {};
  for (const [name, info] of Object.entries(ns.gang.getAllGangInformation())) {
    if (name !== own) power[name] = info.power;
  }
  return power;
}

/** Rewrites the tail window: the gang on one line, then one line per member. */
function printStatus(ns: NS): void {
  const gang = ns.gang.getGangInformation();
  const nextRecruit = Number.isFinite(gang.respectForNextRecruit)
    ? `next recruit at ${ns.format.number(gang.respectForNextRecruit)}`
    : "full";

  ns.clearLog();
  ns.print(
    `Respect ${ns.format.number(gang.respect)} (${nextRecruit})  ` +
      `wanted penalty ${ns.format.percent(1 - gang.wantedPenalty)}  ` +
      `territory ${ns.format.percent(gang.territory)}  ` +
      `power ${ns.format.number(gang.power)}  ` +
      `clashes ${gang.territoryWarfareEngaged ? "on" : "off"}`,
  );
  for (const name of ns.gang.getMemberNames()) {
    const m = ns.gang.getMemberInformation(name);
    
    ns.print(
      `${name.padEnd(10)} ${m.task.padEnd(18)} ` +
        `str ${m.str} def ${m.def} dex ${m.dex} hack ${m.hack} cha ${m.cha}  ` +
        `asc x${ns.format.number(m.str_asc_mult, 2)}`,
    );
  }
}
