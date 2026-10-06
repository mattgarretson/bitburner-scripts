# Automation ideas

Future scripts, roughly best value first. Items 1–3 together cover the whole
reset cycle, so they are the next ones to build. Singularity scripts go in
`src/singularity/`.

Already done: `singularity/buy-programs.ts` (TOR + every darkweb program) and
`singularity/backdoor.ts` (backdoors every reachable server, faction servers
first).

1. **Faction auto-join** — accept every invite except factions that are
   enemies of ones still needed, such as the city factions that lock each
   other out (`checkFactionInvitations`, `getFactionEnemies`, `joinFaction`).
2. **Augmentation buyer and reset** — at a money or reputation threshold, buy
   augmentations most expensive first (prices rise after each purchase), then
   NeuroFlux Governor with what's left, then
   `installAugmentations("singularity/startup.ts")`.
3. **Startup script** — the script the reset hands off to. Relaunches
   `multi-manager.ts`, `cloud-manager.ts`, `singularity/buy-programs.ts` and
   `singularity/backdoor.ts`. With #2, this covers most of what's done by hand
   at the start of every run.
4. **Home upgrades** — buy home RAM and cores whenever the price is below some
   fraction of current money (`upgradeHomeRam`, `upgradeHomeCores`). More home
   RAM feeds the batcher directly.
5. **Reputation grinding** — work for whichever faction holds the next wanted
   augmentation, pick the best work type (hacking contracts), and switch
   factions once there's enough reputation. Donate money once a faction has
   enough favor (`workForFaction`, `donateToFaction`).
6. **Karma/crime loop** — commit crimes until karma is low enough to start a
   gang in non-gang BitNodes, then hand off to the `src/gang/` scripts
   (`commitCrime`, `getCrimeChance`).
7. **Coding contracts** — find `.cct` files across the network and solve them
   for money or reputation. Doesn't need the Singularity API.
8. **BitNode finisher** — once hacking level is high enough, call
   `destroyW0r1dD43m0n(nextBN, "singularity/startup.ts")`. Chained with the
   rest, a whole BitNode could run with almost no input.
