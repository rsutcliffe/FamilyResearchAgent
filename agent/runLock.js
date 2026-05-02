// Per-individual run lock. Defends against unintended re-fires of expensive
// agent runs — particularly EventSource auto-reconnect after a clean close,
// which on 2026-05-01 produced 51 back-to-back runs on a single individual.
//
// Two states per id:
//   - "in-flight":  a run is currently executing
//   - "cool-down":  the run finished recently; refuse new runs until expiry
//
// `tryAcquireRunLock` returns { ok: true } or { ok: false, reason } so the
// caller can respond with a meaningful 429 message. `releaseRunLock` is
// idempotent and safe to call from a `finally` even if acquire never
// happened.

const DEFAULT_COOLDOWN_MS = 30_000;

// Shared mutable state. Module scope so test resets are explicit.
const lockState = new Map();
// In-flight registry: id → { ac, startedAt, label }. Used by /api/runs/*
// to surface which runs are currently consuming Anthropic spend so the
// user can see and cancel them from the UI.
const inFlightRuns = new Map();

export const tryAcquireRunLock = (
  id,
  { now = Date.now, cooldownMs = DEFAULT_COOLDOWN_MS } = {},
) => {
  if (!id) return { ok: false, reason: "missing id" };
  const t = now();
  const entry = lockState.get(id);
  if (entry?.state === "in-flight") {
    return {
      ok: false,
      reason: "A run for this individual is already in progress. Wait for it to finish or refresh the page.",
    };
  }
  if (entry?.state === "cool-down" && entry.until > t) {
    const seconds = Math.ceil((entry.until - t) / 1000);
    return {
      ok: false,
      reason: `Re-run guard: this individual just finished a run ${Math.ceil((cooldownMs - (entry.until - t)) / 1000)}s ago. Wait ${seconds}s or refresh the page to re-run.`,
    };
  }
  lockState.set(id, { state: "in-flight", since: t, cooldownMs });
  return { ok: true };
};

export const releaseRunLock = (id, { now = Date.now } = {}) => {
  if (!id) return;
  const entry = lockState.get(id);
  if (!entry) return;
  const cooldownMs = entry.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  lockState.set(id, { state: "cool-down", until: now() + cooldownMs });
};

export const __resetRunLockForTests = () => {
  lockState.clear();
  inFlightRuns.clear();
};

// Register an in-flight run so /api/runs/active can surface it. Pass the
// AbortController so /api/runs/abort/:id can cancel it. `label` is a
// human-readable description (e.g. "Ann Sweeting (record discovery)" or
// "Joseph Sutcliffe — find father").
export const registerInFlightRun = (id, ac, label = "") => {
  inFlightRuns.set(id, { ac, startedAt: Date.now(), label });
};

export const unregisterInFlightRun = (id) => {
  inFlightRuns.delete(id);
};

// Snapshot of currently in-flight runs for the UI. Each entry includes
// elapsed_ms so the frontend can render "running for 27s" etc.
export const listInFlightRuns = ({ now = Date.now } = {}) => {
  const t = now();
  return Array.from(inFlightRuns.entries()).map(([id, { startedAt, label }]) => ({
    id,
    label,
    started_at: new Date(startedAt).toISOString(),
    elapsed_ms: t - startedAt,
  }));
};

// Cancel an in-flight run by signal-aborting its AbortController. Returns
// true if the run was found and aborted, false if the id wasn't in flight.
export const abortInFlightRun = (id) => {
  const entry = inFlightRuns.get(id);
  if (!entry) return false;
  try {
    entry.ac.abort();
  } catch {
    /* abort can throw if controller is already aborted — ignore */
  }
  inFlightRuns.delete(id);
  return true;
};
