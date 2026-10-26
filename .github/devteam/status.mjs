#!/usr/bin/env node
// Keeps one live status comment per issue. The comment's hidden base64 JSON is the
// run's state: every job reads and rewrites it, and the dashboard reads the same data.
//
// CLI (needs GH_TOKEN, GITHUB_REPOSITORY, ISSUE):
//   node status.mjs init                      start a fresh run (planned steps = pending)
//   node status.mjs set key=value ...         set top-level fields (pr, branch, state)
//   node status.mjs finish <done|failed|needs_info|changes_requested>
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- devteam-status -->';
const DATA = /<!-- devteam-data:([A-Za-z0-9+/=]+) -->/;
const PLANNED = ['planner', 'coder', 'tester', 'reviewer'];

const repo = process.env.GITHUB_REPOSITORY;
const issue = process.env.ISSUE;

function gh(args, input) {
  return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

function findComment() {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments`]));
  return pages.flat().find((c) => c.body?.includes(MARKER));
}

export function readState(body) {
  const m = body?.match(DATA);
  return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
}

export function update(mutate) {
  const comment = findComment();
  const state = readState(comment?.body) ?? { repo, issue: Number(issue), steps: [] };
  mutate(state);
  state.updatedAt = new Date().toISOString();
  const body = JSON.stringify({ body: render(state) });
  if (comment) gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${comment.id}`, '--input', '-'], body);
  else gh(['api', '-X', 'POST', `repos/${repo}/issues/${issue}/comments`, '--input', '-'], body);
  return state;
}

// Status updates must never fail the pipeline itself.
export function safeUpdate(mutate) {
  try {
    return update(mutate);
  } catch (err) {
    console.warn(`::warning::status comment update failed: ${err.message}`);
  }
}

function findOrInsertStep(state, role, round) {
  let step = state.steps.find((s) => s.role === role && s.round === round);
  if (!step) {
    step = { role, round, state: 'pending' };
    const i = state.steps.findIndex((s) => s.state === 'pending');
    state.steps.splice(i === -1 ? state.steps.length : i, 0, step);
  }
  return step;
}

export function startStep(role, round, model) {
  safeUpdate((s) => {
    Object.assign(findOrInsertStep(s, role, round), { model, state: 'running', startedAt: new Date().toISOString() });
  });
}

export function finishStep(role, round, fields) {
  safeUpdate((s) => {
    Object.assign(findOrInsertStep(s, role, round), fields, { endedAt: new Date().toISOString() });
  });
}

const ICON = { pending: '⚪', running: '🔵', done: '✅', failed: '❌', skipped: '⏭️' };
const STATE_LABEL = {
  running: '🔵 running',
  done: '✅ done',
  failed: '❌ failed',
  needs_info: '❓ needs info from you',
  changes_requested: '🟠 reviewer requested changes',
};

function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const fmtCost = (usd) => (usd == null ? '' : `$${usd.toFixed(2)}`);
const shortModel = (m) => (m ?? '').replace(/^claude-/, '');

function render(s) {
  const rows = s.steps.map((st, i) => {
    const name = st.round > 1 ? `${st.role} (round ${st.round})` : st.role;
    return `| ${i + 1} | ${name} | ${shortModel(st.model)} | ${ICON[st.state]} ${st.state} | ${st.verdict ?? ''} | ${fmtDuration(st.durationMs)} | ${fmtCost(st.costUsd)} |`;
  });

  const nodes = s.steps.map((st, i) => {
    const name = st.round > 1 ? `${st.role} r${st.round}` : st.role;
    const sub = [st.verdict, fmtDuration(st.durationMs)].filter(Boolean).join(' · ');
    return `  s${i}["${name}${sub ? `<br/>${sub}` : ''}"]:::${st.state}`;
  });
  const edges = s.steps.slice(1).map((_, i) => `  s${i} --> s${i + 1}`);

  const total = s.steps.reduce((sum, st) => sum + (st.costUsd ?? 0), 0);
  const links = [
    s.runUrl && `[workflow run](${s.runUrl})`,
    s.branch && `branch \`${s.branch}\``,
    s.pr && `PR #${s.pr}`,
  ].filter(Boolean);

  return [
    MARKER,
    `### 🤖 Dev team: ${STATE_LABEL[s.state] ?? s.state ?? ''}`,
    links.join(' · '),
    '',
    '```mermaid',
    'flowchart LR',
    ...nodes,
    ...edges,
    '  classDef pending fill:#f3f4f6,stroke:#9ca3af,color:#374151',
    '  classDef running fill:#dbeafe,stroke:#2563eb,color:#1e3a8a',
    '  classDef done fill:#d1fae5,stroke:#059669,color:#064e3b',
    '  classDef failed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d',
    '  classDef skipped fill:#f9fafb,stroke:#d1d5db,color:#9ca3af,stroke-dasharray:4',
    '```',
    '',
    '| # | Agent | Model | Status | Verdict | Time | Cost |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Total cost: **${fmtCost(total)}** · updated ${s.updatedAt?.replace('T', ' ').slice(0, 16)} UTC`,
    `<!-- devteam-data:${Buffer.from(JSON.stringify(s)).toString('base64')} -->`,
  ].join('\n');
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  return `${GITHUB_SERVER_URL}/${repo}/actions/runs/${GITHUB_RUN_ID}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'init') {
    safeUpdate((s) => {
      Object.assign(s, {
        state: 'running',
        title: process.env.ISSUE_TITLE ?? s.title,
        runUrl: runUrl(),
        startedAt: new Date().toISOString(),
        pr: undefined,
        steps: PLANNED.map((role) => ({ role, round: 1, state: 'pending' })),
      });
    });
  } else if (cmd === 'set') {
    safeUpdate((s) => {
      for (const kv of args) {
        const [k, v] = kv.split(/=(.*)/s);
        s[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
    });
  } else if (cmd === 'finish') {
    safeUpdate((s) => {
      s.state = args[0];
      s.endedAt = new Date().toISOString();
      for (const st of s.steps) {
        if (st.state === 'running') st.state = 'failed';
        if (st.state === 'pending') st.state = 'skipped';
      }
    });
  } else {
    console.error('usage: status.mjs init | set k=v ... | finish <state>');
    process.exit(2);
  }
}
