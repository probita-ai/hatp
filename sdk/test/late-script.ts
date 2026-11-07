// A short-lived program, run by idle.test.ts: nothing but idle() may keep it alive while a late answer is awaited.
import { buildWorld, tripPlan } from "./fixtures.ts";

let late = false;
const w = buildWorld({ airlineMaxHoldSeconds: 41, coordinator: { inDoubtRetryMs: 10, latePollMs: 20, onLateOutcome: () => { late = true; } } });
let online = false;
const commit = w.payments.commit.bind(w.payments);
w.payments.commit = async (req) => {
  if (!online) throw new Error("socket hang up");
  return commit(req);
};
const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
online = true;
await w.coordinator.idle();
console.log(JSON.stringify({ state: record.state, late }));
