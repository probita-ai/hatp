// Money arithmetic shared by the coordinator, gateway and participants, so all three reach the same figure (spec §5.1).
import type { Branch, Money, Plan } from "./types.ts";

/** Removes binary rounding noise, so 0.1 + 0.2 equals 0.3 when amounts are compared. 15 digits is what a double holds exactly. */
export const exact = (value: number) => Number(value.toPrecision(15));

export const withTolerance = (value: number, percent = 0) => exact((value * (100 + percent)) / 100);

const validMoney = (m: Money) => typeof m.value === "number" && Number.isFinite(m.value) && m.value >= 0 && typeof m.currency === "string" && m.currency.length > 0;

/**
 * Why a plan's amounts can't be trusted, if they can't. A negative amount would offset a real cost in
 * the totals and a negative tolerance would shrink them, either one lowering the authority check.
 */
export function amountProblem(plan: Plan): string | undefined {
  for (const b of plan.branches) {
    if (b.amount && !validMoney(b.amount)) return `branch ${b.branchId}: amount must be a finite number of zero or more`;
  }
  for (const g of plan.approvals ?? []) {
    if (g.requirement.amount && !validMoney(g.requirement.amount)) return `group ${g.groupId}: requirement amount must be a finite number of zero or more`;
  }
  const percent = plan.tolerance?.amountPercent;
  if (percent !== undefined && !(typeof percent === "number" && Number.isFinite(percent) && percent >= 0)) return "tolerance.amountPercent must be a finite number of zero or more";
  return undefined;
}

/** What a branch is planned to cost: its own amount, or the sum of the branches it settles (spec §5.1). */
export function plannedAmount(plan: Plan, branch: Branch): Money | undefined {
  if (!branch.settles) return branch.amount;
  const settled = branch.settles.map((id) => plan.branches.find((b) => b.branchId === id)?.amount);
  const currency = settled[0]?.currency;
  if (!currency || settled.some((m) => m?.currency !== currency)) return undefined;
  return { currency, value: exact(settled.reduce((sum, m) => sum + m!.value, 0)) };
}
