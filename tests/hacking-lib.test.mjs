import assert from "node:assert/strict";
import test from "node:test";

import { applyGrowSafetyMargin, hackTimeScale } from "../src/hacking-lib.ts";

test("hackTimeScale keeps the affine base term for low-level servers", () => {
  assert.ok(Math.abs(hackTimeScale(1, 10, 1) - 502.5 / 525) < 1e-12);
});

test("hackTimeScale approaches the old security ratio at high required skill", () => {
  const actual = hackTimeScale(1_000, 10, 1);
  assert.ok(Math.abs(actual - 3_000 / 25_500) < 1e-12);
  assert.ok(Math.abs(actual - 0.1) < 0.02);
});

test("hackTimeScale returns exactly one when security is unchanged", () => {
  assert.equal(hackTimeScale(250, 7, 7), 1);
});

test("hackTimeScale safely handles missing or zero required skill", () => {
  assert.equal(hackTimeScale(undefined, 10, 1), 1);
  assert.equal(hackTimeScale(0, 10, 1), 1);
});

test("grow safety margin rounds up and never reduces requested threads", () => {
  assert.equal(applyGrowSafetyMargin(100, 0.02), 102);
  assert.equal(applyGrowSafetyMargin(100, -0.5), 100);
});
