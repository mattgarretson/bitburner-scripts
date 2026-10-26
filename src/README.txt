BITBURNER 3.0.2 SCRIPT SUITE

REPLACE A RUNNING SUITE
  run stop-hacking.ts

CHECK TARGETS (launches nothing)
  run multi-manager.ts --report
  run multi-manager.ts --dry         full loop, logs decisions, never execs

START HACKING
  run multi-manager.ts --hack 0.10 --reserve 8 --targets 8

WATCH IT
  tail multi-manager.ts --hack 0.10 --reserve 8 --targets 8    needs the same options it was started with
  ps                                                           lists PIDs; "tail <PID>" works without the options
  run multi-manager.ts --tail --hack 0.10 --reserve 8 --targets 8    opens the log window as it starts

MULTI-MANAGER OPTIONS
  --targets 8      targets tracked at once
  --hack 0.10      maximum fraction stolen per batch
  --reserve 8      RAM kept free on home
  --gap 200        milliseconds between H/W/G/W landings
  --batches 20     maximum batches in a wave
  --lead 1000      launch-safety lead time
  --infra 15       network refresh seconds
  --ttl 5          observation lifetime seconds
  --help           full option list

BATCHER (simpler replacement for multi-manager, on trial; run stop-hacking.ts before switching either way)
  run batcher.ts                     preps every target, then keeps H/W/G/W batches landing on each, best $ per GB of RAM first
  tail batcher.ts                    status: free RAM, hacking $/s since start, one line per target
  Settings are constants at the top of batcher.ts: HACK_FRACTION (0.5), GAP_MS (200), HOME_RESERVE_GB (8)
  run hack-income.ts                 measures hacking $/s over 5 minutes, for comparing the two; start it ~5 min after the manager

OTHER UTILITIES
  run cloud-manager.ts [--yolo]      buy/upgrade cloud servers evenly until maxed (--yolo: spend every dollar, no cap or reserve)
  run cloud-step.ts                  make just the one purchase cloud-manager would make next, print it, exit
  run cloud-sizes.ts                 list every cloud server's RAM, plus the total
  run network-ram.ts                 used/free RAM on every rooted server that is not home or cloud, plus RAM still behind unopened ports
  run xp-farm.ts joesguns [home GB to keep] [--cloud [--keep N]]   grow loop for hacking XP (--keep: cloud servers left free, default 1)
  run xp-farm.ts joesguns --host pserv-03                          same loop on that one server only; home is left alone
  run path.ts CSEC
  run stop-hacking.ts

GANG (needs a gang)
  run gang/manager.ts                           runs the gang until killed: recruit, train, ascend, buy gear, work, take territory (~35 GB)
  run gang/set-activity.ts Territory Warfare    puts every member on that task; exact name, leave it out to list them
                                                (kill gang/manager.ts first, or it puts them back)
  One-word shortcuts, typed once in the Terminal (they are kept in the save, not on home):
    alias gjustice="run gang/set-activity.ts Vigilante Justice"
    alias gmug="run gang/set-activity.ts Mug People"
    alias gtraffick="run gang/set-activity.ts Human Trafficking"
    alias gcombat="run gang/set-activity.ts Train Combat"
    alias ghack="run gang/set-activity.ts Train Hacking"
    alias gwar="run gang/set-activity.ts Territory Warfare"

SINGULARITY (needs BitNode 4 or Source-File 4)
  run singularity/buy-programs.ts    buys TOR + every darkweb program, cheapest first
  run singularity/backdoor.ts        backdoors every server you can, faction servers first
  run singularity/workout.ts [level] trains str/def/dex/agi to that level (default 200) at Powerhouse Gym, then exits
  run singularity/buy-augs.ts        buys every augmentation you can, priciest first, then NeuroFlux levels (~418 GB at SF4 level 1)

SINGULARITY, ONE CALL EACH (cheap on RAM; each earns Intelligence exp the UI button does not)
  run singularity/buy-aug.ts NeuroFlux Governor   buys just that augmentation, exact name (~82 GB at SF4 level 1)
  run singularity/install-augs.ts                 asks, then installs your augmentations and resets (~82 GB)
  run singularity/upgrade-home-ram.ts             buys every home RAM upgrade you can afford (~50 GB)
  run singularity/upgrade-home-cores.ts           buys every home core you can afford (~50 GB)
  run singularity/join-factions.ts                accepts every waiting invitation except city factions (~50 GB)

GRAFTING (needs BitNode 10 or Source-File 10; graft.ts needs you in New Tokyo first, graft-list.ts travels there itself)
  run singularity/graft.ts SPTN-97 Gene Modification   starts grafting just that augmentation, exact name, then exits (~9.6 GB)
  run singularity/graft-list.ts combat                 grafts that list (combat or money, set at the top of the file) one after another; leave the game open (~47 GB)
  run singularity/graft-list.ts "Bionic Spine" "Bionic Legs"   same, but grafts the augmentations you name, in order; quote each exact name
