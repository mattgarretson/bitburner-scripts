# Bitburner manager project

## Environment

This repository contains scripts for Bitburner 3.0.2.

Game scripts live in `src/` and are uploaded to Bitburner's `home`
server by bitburner-filesync.

Codex cannot execute Bitburner itself. Do not claim integration behavior
was tested inside the game.

## Existing architecture

- `manager.js` is the stable single-target manager.
- `hacking-lib.js` contains network scanning, target analysis, RAM
  allocation, and batch calculations.
- Worker scripts perform exactly one hack, grow, or weaken operation.
- Do not modify `manager.js` while developing the multi-target version.
- New work belongs in `multi-manager.js` and reusable library modules.

## Requirements

- Keep the top-level scheduler readable.
- Separate pure planning code from Netscript API calls.
- Plan jobs before launching them.
- Never intentionally launch partial HGW batches.
- Roll back launched processes if a planned batch fails partway through.
- Preserve configurable home RAM.
- Avoid scheduling against stale current-state assumptions.
- Display why RAM is idle.
- Add tests for pure scheduling and allocation logic.

## Validation

Run:

npm test

Also run syntax and type checking before completing a task.