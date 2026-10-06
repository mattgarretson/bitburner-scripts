BITBURNER 3.0.2 SCRIPT SUITE

REPLACE A RUNNING SUITE
  run stop-hacking.ts

CHECK TARGETS (launches nothing)
  run multi-manager.ts --report
  run multi-manager.ts --dry         full loop, logs decisions, never execs

START HACKING
  run multi-manager.ts --hack 0.10 --reserve 8 --targets 8

WATCH IT
  tail multi-manager.ts

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

OTHER UTILITIES
  run cloud-manager.ts               buy/upgrade cloud servers until maxed
  run xp-farm.ts joesguns [home GB to keep] [--cloud [--keep N]]   grow loop for hacking XP (--keep: cloud servers left free, default 1)
  run path.ts CSEC
  run stop-hacking.ts

SINGULARITY (needs BitNode 4 or Source-File 4)
  run singularity/buy-programs.ts    buys TOR + every darkweb program, cheapest first
  run singularity/backdoor.ts        backdoors every server you can, faction servers first
  run singularity/workout.ts         trains str/def/dex/agi to 200 at Powerhouse Gym, then exits
