# CLAUDE.md

Netscript scripts for **Bitburner 3.0.2**, in **TypeScript**. There is no build step:
`bitburner-filesync` (`npm run sync`) pushes `src/` verbatim to the in-game `home` server
and the game transpiles it, so what you edit is what runs. `tsc` is only a type check.

Claude can't run Bitburner. Never claim anything was tested in-game: Node tests, type
checks and reading code are what can be verified here. `sim/` (gitignored, this machine
only) simulates hacking with the game's formulas; `sim/README.md` explains it. Report its
results as simulated.

## Commands

```
npm test                                   # node --test
npm run check                              # tsc --noEmit
npm run format                             # prettier on src/ and tests/*.{js,ts}
node --test tests/<name>.test.mjs
node --test --test-name-pattern "<regex>"
```

Both `npm test` and `npm run check` must stay green. Tests are `.mjs` files that import
the `.ts` sources directly (Node strips the types) and hand `ns`-using functions a small
fake `ns`. They aren't type-checked, and the format script doesn't match them: run
`npx prettier --write tests/<file>.mjs`.

## Netscript traps

- Imports are relative with an explicit `.ts` extension (`from "./hacking-lib.ts"`): the
  game resolves them as literal paths on `home`. Never let a tool rewrite them.
- A script's RAM cost counts every `ns` function the file references, called or not. The
  workers (`worker-hack.ts`, `worker-grow.ts`, `worker-weaken.ts`) reference one each, and
  every thread the managers launch pays for them: **never modify the workers.**
- `types/NetScriptDefinitions.d.ts` is generated from the running game by filesync: never
  hand-edit it. `types/globals.d.ts` makes `NS` a global type.
- Types are erased at runtime, in the game and in the tests: never rely on one for a
  runtime guarantee, and keep type-only imports under `import type`.
- Bitburner 3.x moved purchased servers to `ns.cloud.*` and formatting to `ns.format.*`;
  snippets found online use the older names.
- Scripts in `src/singularity/` import `../hacking-lib.ts`, so script names they pass to
  Netscript must include the folder.
- `src/README.txt` is the in-game quick reference: keep it in sync with flags and usage.

## Code style

Write for someone reading top to bottom; Prettier owns layout.
`src/singularity/workout.ts` is the reference example.

- `main` reads like a description of the script: high-level steps, each a small named
  function declared below it.
- Names say what things mean: `CONSTANT_CASE` constants, `UpperCamelCase` types,
  `lowerCamelCase` functions. Predicates read as questions, actions as verbs.
- Named functions are function declarations with explicit parameter and return types.
- Guard clauses (`continue`, early `return`) instead of nesting.
- A short `/** JSDoc */` on each helper saying what it does; `//` only for why (a game
  quirk, a non-obvious ordering), never narrating the code. Every script keeps the header
  block: `path — summary`, behaviour notes, `Usage: run ...`, `@param {NS} ns`.
- Tunables are constants at the top of the file; add a flag only when the user asks.
- Lookup tables are `as const`, with types derived from them.
- Expected failures go to the terminal: `ns.tprint`, then end the script (from below
  `main`, a `fail(ns, message): never` helper), never `throw`. Pure functions return
  `ok: false` plus a reason instead.

## Hacking managers

`batcher.ts` is a deliberately simple single-file batcher, on trial against
`multi-manager.ts`. Keep it small: constants only, no flags, no tests. The rules below
don't apply to it.

`multi-manager.ts` is the multi-target scheduler (`--hack`, `--targets`, `--reserve`);
`hacking-lib.ts` holds what other scripts share with it. `docs/` describes an older
design: treat it as history. Rules:

- Plan, then launch: a group is placed on a copy of the runners' free RAM and launched
  all or nothing; if any `ns.exec` fails, the PIDs already started are killed.
- A batch is H + W1 + G + W2. Waves shrink by whole batches only; never drop an operation
  or a compensating weaken. Money prep is always grow plus its weaken.
- Never plan from predicted state or an older reading: every group is planned from a
  reading taken in the loop it launches in, because each hacking level shortens every
  operation and older timings land out of order.
- Batches come before prep: prep only gets RAM no batch can use, and never delays a batch
  window that is known to be coming.
- `--reserve` comes off home's RAM everywhere RAM is measured or used.
- A second running copy prints an error and launches nothing; it never kills the other.
- Planning and scheduling logic needs Node tests in `tests/multi-manager.test.mjs`.
- `hacking-lib.ts`'s batch model has deliberate quirks (such as no hostname on
  `growthAnalyzeSecurity`): read its comments before "fixing" anything.

Workers take `[target, requestedDelay, plannedAt, groupOrBatchId, label]`, subtract launch
skew (`Date.now() - plannedAt`) from the delay, and pass the rest as `additionalMsec`.
Group ids start with `mm-`, which is how a restarted manager finds its own workers.
