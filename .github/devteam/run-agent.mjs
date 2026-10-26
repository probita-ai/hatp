#!/usr/bin/env node
// Runs one agent headlessly with Claude Code and records it in the issue's status comment.
//
// The agent works in a sandbox copy of the repo with no .git and no GitHub token in its
// environment, so it can't push, rewrite history, or read the token. Afterwards its file
// changes are copied back, except changes to .github/workflows and .github/devteam.
// Read-only agents (no Edit/Write tool) get nothing copied back; their final answer is
// saved to --output instead.
//
// Usage (from the repo root): node run-agent.mjs <role> [--round N] [--output .pipeline/x.md]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStep, finishStep } from './status.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [role, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};
const round = Number(opt('round', '1'));
const output = opt('output');

// Where each role's verdict is found.
const VERDICTS = {
  planner: ['.pipeline/spec.md', /STATUS:\s*(READY|NEEDS_INFO)/],
  tester: ['.pipeline/test-report.md', /RESULT:\s*(PASS|FAIL)/],
  reviewer: ['.pipeline/review.md', /VERDICT:\s*(APPROVE|REQUEST_CHANGES)/],
};
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];
const NEVER = ['WebFetch', 'WebSearch', 'Agent'];

function loadAgent(name) {
  const text = fs.readFileSync(path.join(here, 'agents', `${name}.md`), 'utf8');
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = Object.fromEntries(
    front.split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  return { ...meta, tools: meta.tools.split(/,\s*/), prompt: body.trim() };
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const agent = loadAgent(role);
const repoDir = process.cwd();
const canWrite = agent.tools.some((t) => WRITE_TOOLS.includes(t));

const ws = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `devteam-${role}-`));
execFileSync('rsync', ['-a', '--exclude=/.git', `${repoDir}/`, `${ws}/`]);

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(GH_|GITHUB_TOKEN|ACTIONS_)/.test(k) || (/^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k) && !env[k])) {
    delete env[k];
  }
}

const task = [
  `You are the ${role} for issue #${process.env.ISSUE} in ${process.env.GITHUB_REPOSITORY}.`,
  round > 1 ? `This is fix round ${round}.` : '',
  'The handoff files are in .pipeline/. Do your job now, exactly as your instructions describe.',
  canWrite
    ? ''
    : `You have no tools that write files, so don't try. Your final answer is saved verbatim to ${output}: reply with only that file's content, no preamble.`,
].join(' ');

const args = [
  '-p',
  '--model', agent.model,
  '--append-system-prompt', agent.prompt,
  '--output-format', 'json',
  '--max-budget-usd', agent.budget_usd ?? '5',
  '--allowedTools', agent.tools.join(','),
  '--disallowedTools', [...WRITE_TOOLS.filter((t) => !agent.tools.includes(t)), ...NEVER].join(','),
];

console.log(`::group::${role} (round ${round}) · ${agent.model} · tools: ${agent.tools.join(', ')}`);
startStep(role, round, agent.model);
const started = Date.now();
const proc = spawnSync('claude', args, {
  cwd: ws, env, input: task, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let result = {};
try {
  result = JSON.parse(proc.stdout);
} catch {
  console.error(proc.stdout?.slice(-4000));
}

if (canWrite) {
  execFileSync('rsync', [
    '-a', '--delete', '--exclude=/.git', '--exclude=/.github/workflows/', '--exclude=/.github/devteam/',
    `${ws}/`, `${repoDir}/`,
  ]);
}
if (output && result.result) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.result.replace(/^```\w*\n([\s\S]*)\n```\s*$/, '$1') + '\n');
}

const [verdictFile, verdictRe] = VERDICTS[role] ?? [];
const verdict = verdictFile
  ? fs.existsSync(verdictFile) && fs.readFileSync(verdictFile, 'utf8').match(verdictRe)?.[1]
  : 'DONE';
const ok = proc.status === 0 && !result.is_error && Boolean(verdict);

const run = {
  role, round, model: agent.model, verdict: verdict || null, ok,
  costUsd: result.total_cost_usd ?? null,
  durationMs: Date.now() - started,
  turns: result.num_turns ?? null,
  permissionDenials: result.permission_denials?.length ?? 0,
};
fs.mkdirSync('.pipeline/runs', { recursive: true });
fs.writeFileSync(`.pipeline/runs/${role}-r${round}.json`, JSON.stringify(run, null, 2) + '\n');

finishStep(role, round, {
  state: ok ? 'done' : 'failed',
  verdict: run.verdict ?? undefined,
  costUsd: run.costUsd ?? undefined,
  durationMs: run.durationMs,
  turns: run.turns ?? undefined,
});
console.log(JSON.stringify(run, null, 2));
console.log('::endgroup::');
fs.rmSync(ws, { recursive: true, force: true });

setOutput('verdict', run.verdict ?? '');
if (!ok) {
  console.error(`::error::${role} failed (exit ${proc.status}${proc.error ? `, ${proc.error.message}` : ''}, verdict: ${verdict || 'missing'})`);
  process.exit(1);
}
