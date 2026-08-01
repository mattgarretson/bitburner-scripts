BITBURNER 3.0.2 SCRIPT SUITE — MANAGER V3

UPLOAD
  Extract this folder, go to home in Bitburner, then:
    upload .

REPLACE THE OLD MANAGER
  run stop-hacking.js
  Upload this entire folder and replace the old files.

CHECK TARGETS
  run manager.js --report

  scout.js now uses the exact same full-batch target model:
    run scout.js

START HACKING
  run manager.js --hack 0.10 --reserve 8 --batches 20

WATCH IT
  tail manager.js --hack 0.10 --reserve 8 --batches 20

MANAGER OPTIONS
  --target auto              automatic target selection
  --target sigma-cosmetics   force one target
  --hack 0.10                maximum fraction stolen per batch
  --reserve 8                RAM kept free on home
  --gap 200                  milliseconds between H/W/G/W landings
  --batches 20               maximum batches in a wave
  --retarget 30              recalculate target rankings every 30 seconds
  --switch 1.05              switch when another target scores 5% better
  --switch 1                 always use the current #1 target
  --lead 1000                launch-safety lead time

WHAT MANAGER V3 CHANGES
  - manager.js is readable orchestration; calculations live in hacking-lib.js
  - target scoring pays for hack, grow, and both weaken operations
  - ranking models expected income using current free RAM and wave size
  - target switching threshold is 5%, not the old 25%
  - all batches in a wave are allocated before anything launches
  - a partial launch failure rolls back the whole wave
  - workers compensate for launch skew to keep completion order cleaner
  - network rooting and worker deployment happen periodically, not every phase

OTHER UTILITIES
  run hacknet-roi.js 0.10 1000000 3600 12
  run cloud-manager.js 0.20 5000000 8
  run path.js CSEC
  run find-contracts.js
  run stop-hacking.js
