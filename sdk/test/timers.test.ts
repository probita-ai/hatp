// Timers: deadlines further away than setTimeout can count (24.8 days), and channels that ignore `signal`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDigest, createHumanGateway, HatpError, setLongTimeout } from "../src/index.ts";
import type { Action, AskApproveRequest, HumanChannel } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const role = "human://acme.com/role/finance-approver";
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const action: Action = { type: "mcp.tools/call", server: "https://payments.example", tool: "charge_card", arguments: { amount: { value: 120, currency: "USD" } } };
const ask = (decideBy: string): AskApproveRequest => ({ address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action, actionDigest: actionDigest(action), decideBy });
const isCode = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;

test("setLongTimeout fires for short delays and can be cleared", async () => {
  let fired = 0;
  setLongTimeout(() => fired++, 5);
  const cleared = setLongTimeout(() => fired++, 5);
  cleared.clear();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 1);
});

test("an ask whose decideBy is 30 days away does not expire at once", async () => {
  // setTimeout fires a 30-day delay after 1 ms; the human decides after 30 ms.
  const w = buildWorld({ gatewayMsPerSecond: 1000, script: { [alice]: { decision: "approve", afterMs: 30 } } });
  const r = await w.gateway.askApprove(ask(days(30)));
  assert.equal(r.decision, "approve");
});

test("a transaction whose deadline is 40 days away commits", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve", afterMs: 30 } } });
  const record = await w.coordinator.run(tripPlan({ deadline: days(40), prepareOrder: "approval-first" }, { decideBy: days(35) }));
  assert.equal(record.state, "COMMITTED", JSON.stringify(record.events.find((e) => e.type === "decision")?.data));
});

test("a channel that ignores the abort signal can't hold an ask past decideBy", { timeout: 3000 }, async () => {
  const w = buildWorld();
  const never = () => new Promise<never>(() => {}); // never settles, never looks at signal
  const channel: HumanChannel = { deliver: never, deliverAction: never, deliverQuestion: never };
  const gateway = createHumanGateway({ id: w.gateway.id, signer: w.gatewaySigner, directory: w.directory, channel, msPerSecond: 1000 });
  await assert.rejects(gateway.askApprove(ask(new Date(Date.now() + 80).toISOString())), isCode("DEADLINE_EXCEEDED"));
});
