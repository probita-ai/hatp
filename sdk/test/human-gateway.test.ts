import assert from "node:assert/strict";
import { test } from "node:test";
import { createSigner, Directory, escalationWorstCase, signCard } from "../src/index.ts";
import type { HumanCard } from "../src/index.ts";

function directory(cards: { id: string; decideSeconds: number; delegates?: string[] }[]) {
  const issuer = createSigner("https://directory.acme.com");
  const dir = new Directory([issuer.publicJwk]);
  for (const c of cards) {
    const card: HumanCard = {
      id: c.id, displayName: c.id, org: "acme.com", roles: ["finance-approver"], authority: [{ action: "approve.spend" }],
      channels: ["web"], sla: { decideSeconds: c.decideSeconds }, delegates: c.delegates, keys: [], issuer: issuer.id,
    };
    dir.add(signCard(card, issuer));
  }
  return dir;
}

test("worst case sums SLAs along the escalation chain", () => {
  // The dev.to example: two 900 s approvers outlast a 20-minute seat hold.
  const dir = directory([{ id: "human://acme.com/bob", decideSeconds: 900 }, { id: "human://acme.com/carol", decideSeconds: 900 }]);
  assert.equal(escalationWorstCase(dir, ["human://acme.com/bob", "human://acme.com/carol"], 1), 1800);
});

test("delegates are counted in the order the gateway asks them", () => {
  const dir = directory([
    { id: "human://acme.com/alice", decideSeconds: 300, delegates: ["human://acme.com/carol"] },
    { id: "human://acme.com/bob", decideSeconds: 600 },
    { id: "human://acme.com/carol", decideSeconds: 60 },
  ]);
  assert.equal(escalationWorstCase(dir, ["human://acme.com/alice", "human://acme.com/bob", "human://acme.com/carol"], 1), 960);
});

test("parallel quorum slots share the chain", () => {
  // Slots start with alice (300) and bob (600). Alice times out first and escalates to carol (+60 → 360).
  // Carol times out next with nobody left. Bob's slot ends at 600.
  const dir = directory([
    { id: "human://acme.com/alice", decideSeconds: 300 },
    { id: "human://acme.com/bob", decideSeconds: 600 },
    { id: "human://acme.com/carol", decideSeconds: 60 },
  ]);
  assert.equal(escalationWorstCase(dir, ["human://acme.com/alice", "human://acme.com/bob", "human://acme.com/carol"], 2), 600);
});
