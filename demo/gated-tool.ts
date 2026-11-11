// Approval-gated tools over MCP (Human Gateway SEP §5–§6.1), end to end:
// an agent, a Human Gateway, and a payments server whose charge_card needs a finance approver's yes.
// Run from the repo root: npm run demo:gated
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { actionDigest, createApprovalGate, createHumanGateway, createSigner, Directory, HatpError, paymentTermsProblem, signCard } from "hatp-protocol";
import type { Action, HumanChannel, Payment, PaymentTerms } from "hatp-protocol";
import { callGatedTool, gateTools, humanGatewayClientCapabilities, mcpHumanGateway, requiresOf, serveHumanGateway } from "hatp-mcp";
import { z } from "zod";

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const step = (n: number, text: string) => console.log(`\n${c.bold}${n}. ${text}${c.reset}`);
const ok = (text: string) => console.log(`   ${c.green}✓${c.reset} ${text}`);
const refused = (text: string) => console.log(`   ${c.red}✗${c.reset} ${text}`);
function expect(cond: unknown, what: string): asserts cond {
  if (!cond) {
    console.error(`${c.red}demo failed: ${what}${c.reset}`);
    process.exit(1);
  }
}
async function expectRefusal(p: Promise<unknown>, code: string): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e instanceof HatpError && e.code === code, `expected ${code}, got ${String(e)}`);
    return e.message;
  }
  expect(false, `expected ${code}, but the call ran`);
}

// ---- the organisation: one finance approver, Bob ----
const USDC = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const issuer = createSigner("https://directory.acme.com");
const directory = new Directory([issuer.publicJwk]).add(signCard({
  id: "human://acme.com/bob", displayName: "Bob Chen", org: "acme.com", roles: ["finance-approver"],
  authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }, { action: "approve.spend", maxAmount: { value: 50_000_000, currency: USDC } }],
  channels: ["web"], sla: { decideSeconds: 900 }, keys: [], issuer: issuer.id,
}, issuer));

// Bob's channel: shows the structured action, and the agent's text apart from it, then approves after a moment.
const channel: HumanChannel = {
  deliver: () => new Promise(() => {}),
  deliverAction: (ask, human, signal) => new Promise((resolve, reject) => {
    const pay = ask.action.payment ? `, paying up to ${Number(ask.action.payment.maxAmount) / 1e6} USDC to ${ask.action.payment.payTo}` : "";
    console.log(`   ${c.cyan}ask${c.reset} → ${human.displayName}: ${ask.action.tool}(${JSON.stringify(ask.action.arguments)}) on ${ask.audience}${pay}`);
    if (ask.agentProvidedText) console.log(`   ${c.dim}    agent says: "${ask.agentProvidedText}"${c.reset}`);
    const t = setTimeout(() => {
      console.log(`   ${c.cyan}${human.displayName} approves${c.reset}`);
      resolve({ decision: "approve", method: "demo" });
    }, 600);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
  }),
};
const gatewaySigner = createSigner("https://gateway.acme.com");
const gateway = createHumanGateway({ id: gatewaySigner.id, signer: gatewaySigner, directory, channel });
const gatewayServer = new McpServer({ name: "acme-human-gateway", version: "0.0.0" });
serveHumanGateway(gatewayServer, gateway, { extension: { gatewayId: gatewaySigner.id, orgs: ["acme.com"], keys: [gatewaySigner.publicJwk], assurance: ["gateway-attested"] }, cards: directory });

// ---- the payments server: charge_card needs an approval; premium_report is paid and sets its own price ----
const serverId = "https://payments.example";
const charged: string[] = [];
let reportPrice = "2000000"; // 2.00 USDC
const terms = (): PaymentTerms => ({ network: "eip155:8453", asset: USDC, amount: reportPrice, payTo: "0x9a3f" });
const payments = new McpServer({ name: "payments", version: "0.0.0" });
payments.registerTool("charge_card", { description: "Charge the corporate card", inputSchema: { amount: z.object({ value: z.number(), currency: z.string() }), payee: z.string() } }, async (args) => {
  charged.push(`${args.amount.value} ${args.amount.currency} to ${args.payee}`);
  return { content: [{ type: "text", text: `charged ${args.amount.value} ${args.amount.currency} to ${args.payee}` }] };
});
payments.registerTool("premium_report", { description: "A paid research report", inputSchema: { ticker: z.string() } }, async (args) => ({ content: [{ type: "text", text: `report on ${args.ticker}` }] }));
const finance = "human://acme.com/role/finance-approver";
gateTools(payments, {
  gate: createApprovalGate({ serverId, trustedGateways: { [gatewaySigner.id]: [gatewaySigner.publicJwk] } }),
  extension: { serverId, trustedGateways: [gatewaySigner.id] },
  tools: {
    charge_card: { requires: { address: finance, requirement: { action: "approve.spend", amountFrom: "/amount" } } },
    premium_report: { requires: { address: finance, requirement: { action: "approve.spend", amountFrom: "payment" }, payment: { network: "eip155:8453", asset: USDC } }, terms },
  },
});

// ---- the agent connects to both ----
async function connect(server: McpServer | Server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "travel-bot", version: "0.0.0" }, { capabilities: humanGatewayClientCapabilities });
  await client.connect(a);
  return client;
}
const gw = mcpHumanGateway(await connect(gatewayServer), { issuerKeys: [issuer.publicJwk] });
const pay = await connect(payments);
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

step(1, "The agent reads what charge_card requires");
const listed = (await pay.listTools()).tools;
const requires = requiresOf(listed.find((t) => t.name === "charge_card")!)!;
expect(requires, "charge_card advertises requires");
ok(`charge_card needs an approval from ${requires.address}, checked against the amount at ${requires.requirement.amountFrom}`);
const { cards } = await gw.cards();
ok(`the gateway's cards verify against the directory's key: ${cards.map((x) => x.displayName).join(", ")}`);

const args = { amount: { value: 2140, currency: "USD" }, payee: "Lufthansa" };
step(2, "Calling it without an approval");
refused(await expectRefusal(callGatedTool(pay, { name: "charge_card", arguments: args }), "APPROVAL_REQUIRED"));
expect(charged.length === 0, "nothing charged");

step(3, "The agent asks the Human Gateway");
const action: Action = { type: "mcp.tools/call", server: serverId, tool: "charge_card", arguments: args };
const { decision, approvals } = await gw.askApprove({ address: requires.address, requirement: requires.requirement, action, actionDigest: actionDigest(action), decideBy: inMin(15), purpose: "Flight FRA→SFO for the Q4 customer visit" });
expect(decision === "approve", "approved");
ok(`${approvals[0].approver} approved; signed by ${approvals[0].issuer}, for ${approvals[0].audience}, until ${approvals[0].expiresAt}`);

step(4, "Calling it with the approval");
await callGatedTool(pay, { name: "charge_card", arguments: args, approvals });
expect(charged.length === 1, "charged once");
ok(`payments ran the tool: ${charged[0]}`);

step(5, "Replaying the same approval");
refused(await expectRefusal(callGatedTool(pay, { name: "charge_card", arguments: args, approvals }), "APPROVAL_INVALID"));

step(6, "Using the approval with changed arguments");
refused(await expectRefusal(callGatedTool(pay, { name: "charge_card", arguments: { ...args, payee: "Mallory Air" }, approvals }), "APPROVAL_INVALID"));
expect(charged.length === 1, "still charged once");

step(7, "A paid tool whose server sets the price: the approval covers the payment");
const payment: Payment = { network: "eip155:8453", asset: USDC, maxAmount: "2500000", payTo: "0x9a3f" }; // up to 2.50 USDC
const paid: Action = { type: "mcp.tools/call", server: serverId, tool: "premium_report", arguments: { ticker: "ACME" }, payment };
const reportReq = requiresOf(listed.find((t) => t.name === "premium_report")!)!;
const report = await gw.askApprove({ address: reportReq.address, requirement: reportReq.requirement, action: paid, actionDigest: actionDigest(paid), decideBy: inMin(15) });
expect(paymentTermsProblem(payment, terms()) === undefined, "payer accepts 2.00 USDC");
ok("the payer's wallet checks the server's terms (2.00 USDC) against the approval: within it");
await callGatedTool(pay, { name: "premium_report", arguments: { ticker: "ACME" }, approvals: report.approvals, payment });
ok("premium_report ran");

step(8, "The server raises its price above what was approved");
reportPrice = "3000000";
const problem = paymentTermsProblem(payment, terms());
expect(problem, "payer refuses");
refused(`the payer's wallet refuses to sign: ${problem}`);
const again = await gw.askApprove({ address: reportReq.address, requirement: reportReq.requirement, action: paid, actionDigest: actionDigest(paid), decideBy: inMin(15) });
refused(await expectRefusal(callGatedTool(pay, { name: "premium_report", arguments: { ticker: "ACME" }, approvals: again.approvals, payment }), "APPROVAL_INVALID"));

console.log(`\n${c.green}Every check behaved as the SEP requires.${c.reset}`);
process.exit(0);
