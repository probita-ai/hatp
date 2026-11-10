// Locks with fencing tokens (spec §7.6).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFencingGuard, createLockManager } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

let clock = 0;
const locks = () => { clock = Date.parse("2026-11-09T12:00:00Z"); return createLockManager({ now: () => clock }); };
const R = "jira://ACME-142";

test("an exclusive lock keeps a second owner out until it expires or is released", async () => {
  const m = locks();
  const a = await m.acquire({ resource: R, ttlSeconds: 60 });
  await assert.rejects(m.acquire({ resource: R, ttlSeconds: 60 }), /LOCK_CONFLICT/);
  await m.release({ resource: R, lockToken: a.lockToken });
  const b = await m.acquire({ resource: R, ttlSeconds: 60 });
  assert.ok(b.fencingToken > a.fencingToken, "every grant gets a higher token");
});

test("shared locks coexist; an exclusive one waits for all of them", async () => {
  const m = locks();
  await m.acquire({ resource: R, mode: "shared", ttlSeconds: 60 });
  await m.acquire({ resource: R, mode: "shared", ttlSeconds: 60 });
  await assert.rejects(m.acquire({ resource: R, mode: "exclusive", ttlSeconds: 60 }), /LOCK_CONFLICT/);
});

test("renewal keeps the token; a lock that expired can't be renewed", async () => {
  const m = locks();
  const a = await m.acquire({ resource: R, ttlSeconds: 60 });
  clock += 50_000;
  const r = await m.renew({ resource: R, lockToken: a.lockToken, ttlSeconds: 60 });
  assert.equal(r.fencingToken, a.fencingToken);
  clock += 61_000;
  await assert.rejects(m.renew({ resource: R, lockToken: a.lockToken, ttlSeconds: 60 }), /LOCK_CONFLICT/);
});

test("ttl is capped, and tokens never go down even after every lock is released", async () => {
  clock = Date.parse("2026-11-09T12:00:00Z");
  const m = createLockManager({ maxTtlSeconds: 10, now: () => clock });
  const a = await m.acquire({ resource: R, ttlSeconds: 3600 });
  assert.equal(Date.parse(a.expiresAt) - clock, 10_000);
  await m.release({ resource: R, lockToken: a.lockToken });
  assert.equal((await m.acquire({ resource: R, ttlSeconds: 1 })).fencingToken, a.fencingToken + 1);
});

test("an agent paused past its lock's expiry cannot overwrite newer work", async () => {
  const m = locks();
  const guard = createFencingGuard();
  const a = await m.acquire({ resource: R, ttlSeconds: 30 }); // agent A, then a long pause
  clock += 31_000;
  const b = await m.acquire({ resource: R, ttlSeconds: 30 }); // agent B gets the lock and writes
  guard.check(R, b.fencingToken);
  assert.throws(() => guard.check(R, a.fencingToken), /STALE_FENCING_TOKEN/); // A wakes and tries to write
  guard.check(R, b.fencingToken); // B writing again is fine
});

// In a transaction: the calendar write is fenced on the calendar it writes.
test("a transaction whose write carries a stale fencing token votes no at prepare", async () => {
  const w = buildWorld({ calendarFencing: true });
  w.calendarGuard!.check("calendar://dana", 5); // someone with a newer lock already wrote
  const plan = tripPlan();
  plan.branches[2].operation.arguments = { ...plan.branches[2].operation.arguments, fencingToken: 4 };
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "STALE_FENCING_TOKEN");
  assert.ok(!w.effects.includes("calendar:created"));
});

test("a newer lock holder writing between prepare and commit makes the commit fail closed", async () => {
  const w = buildWorld({ calendarFencing: true, script: { "human://acme.com/alice": { decision: "approve", afterMs: 50 } } });
  const plan = tripPlan({ prepareOrder: "parallel" });
  plan.branches[2].operation.arguments = { ...plan.branches[2].operation.arguments, fencingToken: 7 };
  setTimeout(() => w.calendarGuard!.check("calendar://dana", 8), 20); // after prepare, before the human approves
  const record = await w.coordinator.run(plan);
  assert.notEqual(record.state, "COMMITTED");
  assert.ok(!w.effects.includes("calendar:created"));
});

test("a fenced write without a token is refused", async () => {
  const w = buildWorld({ calendarFencing: true });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "PLAN_INVALID");
});

