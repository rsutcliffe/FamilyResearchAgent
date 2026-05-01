import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  tryAcquireRunLock,
  releaseRunLock,
  __resetRunLockForTests,
} from "../../agent/runLock.js";

beforeEach(() => __resetRunLockForTests());

describe("tryAcquireRunLock", () => {
  test("first acquire returns ok", () => {
    assert.deepEqual(tryAcquireRunLock("@A@", { now: () => 1000 }), { ok: true });
  });

  test("second acquire while in-flight is rejected", () => {
    tryAcquireRunLock("@A@", { now: () => 1000 });
    const out = tryAcquireRunLock("@A@", { now: () => 1500 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /already in progress/);
  });

  test("acquires for a different id while another is in-flight succeed", () => {
    tryAcquireRunLock("@A@", { now: () => 1000 });
    assert.deepEqual(tryAcquireRunLock("@B@", { now: () => 1100 }), { ok: true });
  });

  test("after release, acquire is rejected during cool-down", () => {
    tryAcquireRunLock("@A@", { now: () => 1000, cooldownMs: 30_000 });
    releaseRunLock("@A@", { now: () => 5000 });
    const out = tryAcquireRunLock("@A@", { now: () => 6000 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /Re-run guard/);
  });

  test("after release + cool-down expiry, acquire succeeds again", () => {
    tryAcquireRunLock("@A@", { now: () => 1000, cooldownMs: 30_000 });
    releaseRunLock("@A@", { now: () => 5000 });
    // 5000 + 30000 = 35000; query at 35001 should be free
    const out = tryAcquireRunLock("@A@", { now: () => 35_001 });
    assert.deepEqual(out, { ok: true });
  });

  test("releaseRunLock is a no-op when no entry exists", () => {
    releaseRunLock("@NEVER@", { now: () => 0 });
    // Acquire after release-without-acquire still works
    assert.deepEqual(tryAcquireRunLock("@NEVER@", { now: () => 1 }), { ok: true });
  });

  test("missing id is rejected gracefully", () => {
    const out = tryAcquireRunLock(undefined, { now: () => 0 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /missing id/);
  });

  test("simulates the 89-second EventSource reconnect: 2nd attempt 89s after 1st completion is rejected", () => {
    // Approximates the production bug — agent run takes ~85s, browser tries
    // to reconnect ~3s after close, server should refuse for the cooldown.
    tryAcquireRunLock("@RICHARD@", { now: () => 0, cooldownMs: 30_000 });
    releaseRunLock("@RICHARD@", { now: () => 85_000 });
    const reconnect = tryAcquireRunLock("@RICHARD@", { now: () => 89_000 });
    assert.equal(reconnect.ok, false, "reconnect within cool-down must be rejected");
  });
});
