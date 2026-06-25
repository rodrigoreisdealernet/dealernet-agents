#!/usr/bin/env node
// Render the human-facing CI test dashboard from runs.jsonl on the ci-history branch.
//
// Sibling of e2e-history-render.mjs, but suite-agnostic: it discovers every `suite`
// present in the feed (unit, temporal, helm, seed, ...) and charts them together so
// you can see where each test suite is at build-over-build.
//
// Reads the append-only history feed and writes, alongside it:
//   - trend.svg   a dependency-free pass-rate trend (one line per suite)
//   - README.md   a per-suite status table + recent runs + unstable tests, renders in GitHub's UI
//
// Usage: node test-history-render.mjs <history-dir>   (defaults to cwd)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTargets, flag, pctStr, flakiness, meanSkipPct, unstableCount } from './qa-targets.mjs';

const dir = process.argv[2] || '.';
const feed = join(dir, 'runs.jsonl');

const rows = existsSync(feed)
  ? readFileSync(feed, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  : [];

// Stable chronological order (the feed is append-only, but be defensive).
rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

// Discover suites in first-seen order; assign each a stable color.
const PALETTE = ['#1f883d', '#0969da', '#bf8700', '#8250df', '#cf222e', '#1b7c83', '#9a6700', '#bc4c00'];
// `coverage` records (kind:"coverage") are not a pass/fail suite — keep them out of the
// suite discovery and chart them on their own panel.
const isCoverage = (r) => r.kind === 'coverage' || r.suite === 'coverage';
const isQuality = (r) => r.kind === 'quality' || r.suite === 'quality';
const isMetric = (r) => isCoverage(r) || isQuality(r);
const suiteOrder = [];
for (const r of rows) if (r.suite && !isMetric(r) && !suiteOrder.includes(r.suite)) suiteOrder.push(r.suite);
const colorOf = (s) => PALETTE[suiteOrder.indexOf(s) % PALETTE.length];
const bySuite = (s) => rows.filter((r) => r.suite === s && !isMetric(r));
const covRows = () => rows.filter(isCoverage);
const latestQuality = () => (rows.filter(isQuality).slice(-1)[0] || {}).quality || null;
const TARGETS = loadTargets();

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ----------------------------------------------------------------------------- SVG
const W = 920;
const PAD = { l: 56, r: 150, t: 28, b: 40 };
const PANEL_H = 170;
const GAP = 48;
const COV_ROWS = covRows(); // coverage records (kind:"coverage")
const TWO_PANEL = COV_ROWS.length > 0;
const H = PAD.t + PANEL_H + (TWO_PANEL ? GAP + PANEL_H : 0) + PAD.b;
const PLOT_W = W - PAD.l - PAD.r;

const TITLE_ATTR = 'font-size="12" font-weight="600" fill="#1f2328"';
const YLAB_ATTR = 'font-size="10" fill="#656d76" text-anchor="end"';
const GRID_ATTR = 'stroke="#e1e4e8" stroke-width="1"';
const LEGEND_ATTR = 'font-size="11" fill="#1f2328"';

function linePath(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

// Draw one 0–100% panel: gridlines, y-labels, a line per series (red dots where
// series.marks[i] is true), and a right-margin legend. Returns the SVG fragment.
function drawPanel(top, title, series) {
  const y = (v) => top + PANEL_H - (v / 100) * PANEL_H;
  let s = `<text x="${PAD.l}" y="${top - 10}" ${TITLE_ATTR}>${esc(title)}</text>`;
  for (let g = 0; g <= 4; g++) {
    const v = (100 * g) / 4;
    const yy = y(v);
    s += `<line x1="${PAD.l}" y1="${yy.toFixed(1)}" x2="${PAD.l + PLOT_W}" y2="${yy.toFixed(1)}" ${GRID_ATTR}/>`;
    s += `<text x="${PAD.l - 8}" y="${(yy + 3).toFixed(1)}" ${YLAB_ATTR}>${Math.round(v)}%</text>`;
  }
  if (!series.length) {
    s += `<text x="${PAD.l}" y="${top + PANEL_H / 2}" font-size="13" fill="#8b949e">no data yet</text>`;
    return s;
  }
  let legendY = top + 4;
  for (const ser of series) {
    const n = ser.values.length;
    const x = (i) => PAD.l + (n <= 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));
    const pts = ser.values.map((v, i) => [x(i), y(v)]);
    if (pts.length === 1) {
      s += `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3" fill="${ser.color}"/>`;
    } else {
      s += `<path d="${linePath(pts)}" fill="none" stroke="${ser.color}" stroke-width="2"/>`;
    }
    (ser.marks || []).forEach((m, i) => {
      if (m) s += `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="2.6" fill="#d1242f"/>`;
    });
    s += `<rect x="${PAD.l + PLOT_W + 16}" y="${legendY - 9}" width="11" height="11" rx="2" fill="${ser.color}"/>`;
    s += `<text x="${PAD.l + PLOT_W + 32}" y="${legendY}" ${LEGEND_ATTR}>${esc(ser.label)}</text>`;
    legendY += 20;
  }
  return s;
}

function buildSvg() {
  const N = 60; // last N runs per suite

  const passSeries = suiteOrder
    .map((suite) => {
      const runs = bySuite(suite).slice(-N);
      if (!runs.length) return null;
      return {
        label: suite,
        color: colorOf(suite),
        values: runs.map((r) => (r.pass_rate ?? 0) * 100),
        marks: runs.map((r) => r.outcome !== 'passed'),
      };
    })
    .filter(Boolean);

  const top1 = PAD.t;
  let body = drawPanel(top1, `Pass rate by suite (last ${N} runs) — red dot = failing/errored run`, passSeries);

  if (TWO_PANEL) {
    const cov = COV_ROWS.slice(-N);
    const num = (path) => cov.map((r) => path(r.coverage || {})).map((v) => (typeof v === 'number' ? v * 100 : null));
    const stripNull = (arr) => arr.filter((v) => v != null);
    const covSeries = [
      { label: 'unit lines', color: '#1f883d', get: (c) => c.unit?.lines },
      { label: 'e2e screens', color: '#0969da', get: (c) => c.e2e?.screens_pct },
      { label: 'e2e journeys', color: '#8250df', get: (c) => c.e2e?.journeys_pct },
    ]
      .map((d) => ({ label: d.label, color: d.color, values: stripNull(num(d.get)) }))
      .filter((s) => s.values.length);
    body += drawPanel(PAD.t + PANEL_H + GAP, `Coverage (last ${N} records)`, covSeries);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${body}
</svg>`;
}

// --------------------------------------------------------------------------- README
function fmtTs(ts) {
  if (!ts) return '—';
  return ts.replace('T', ' ').replace(/:\d\d\.\d+Z$/, 'Z').replace(/\.\d+Z$/, 'Z');
}
const ICON = { passed: '✅', failed: '❌', error: '🟠' };

function streak(suiteRows) {
  let n = 0;
  for (let i = suiteRows.length - 1; i >= 0; i--) {
    if (suiteRows[i].outcome === 'passed') n++;
    else break;
  }
  return n;
}

function passRateOver(suiteRows, sinceMs) {
  const cut = rows.length ? Date.parse(rows[rows.length - 1].ts || '') - sinceMs : 0;
  const win = suiteRows.filter((r) => Date.parse(r.ts || '') >= cut);
  const passed = win.filter((r) => r.outcome === 'passed').length;
  return win.length ? { pct: Math.round((passed / win.length) * 100), n: win.length } : { pct: null, n: 0 };
}

function suiteSummaryTable() {
  let t = '| Suite | Latest | When (UTC) | Pass 24h | Pass 7d | Skip% (last 20) | Green streak | Runs |\n';
  t += '|---|---|---|--:|--:|--:|--:|--:|\n';
  for (const suite of suiteOrder) {
    const sr = bySuite(suite);
    const latest = sr[sr.length - 1];
    const day = passRateOver(sr, 24 * 3600e3);
    const week = passRateOver(sr, 7 * 24 * 3600e3);
    const latestCell = latest
      ? `${ICON[latest.outcome] || ''} \`${latest.outcome}\`${latest.run_url ? ` [↗](${latest.run_url})` : ''}`
      : '—';
    const skip = pctStr(meanSkipPct(sr.slice(-20)));
    t += `| \`${suite}\` | ${latestCell} | ${fmtTs(latest?.ts)} | ${day.pct == null ? '—' : `${day.pct}% (${day.n})`} | ${week.pct == null ? '—' : `${week.pct}% (${week.n})`} | ${skip} | ${streak(sr)} | ${sr.length} |\n`;
  }
  return t;
}

// --- Targets / SLO breach flags (from .github/qa-targets.json) ---
function latestPassRate(suite) {
  const sr = bySuite(suite);
  return sr.length ? sr[sr.length - 1].pass_rate : null;
}
function targetsSection() {
  if (!TARGETS) return '';
  const rowsOut = [];
  const pr = TARGETS.pass_rate || {};
  for (const suite of Object.keys(pr)) {
    if (!suiteOrder.includes(suite)) continue;
    const min = pr[suite].min ?? 0;
    const val = latestPassRate(suite);
    rowsOut.push([`pass rate · \`${suite}\``, val == null ? '—' : pctStr(val), `≥ ${pctStr(min)}`, flag(val == null ? null : val >= min)]);
  }
  const cov = (covRows().slice(-1)[0] || {}).coverage || null;
  const ct = TARGETS.coverage || {};
  if (cov) {
    const add = (label, val, min) => rowsOut.push([label, val == null ? '—' : pctStr(val), `≥ ${pctStr(min)}`, flag(val == null ? null : val >= min)]);
    if (ct.unit_lines_min != null) add('coverage · unit lines', cov.unit?.lines, ct.unit_lines_min);
    if (ct.unit_branches_min != null) add('coverage · unit branches', cov.unit?.branches, ct.unit_branches_min);
    if (ct.e2e_screens_min != null) add('coverage · e2e screens', cov.e2e?.screens_pct, ct.e2e_screens_min);
    if (ct.e2e_journeys_min != null) add('coverage · e2e journeys', cov.e2e?.journeys_pct, ct.e2e_journeys_min);
  }
  const st = TARGETS.stability || {};
  if (st.max_unstable_tests != null) {
    const n = unstableCount(rows.slice(-80));
    rowsOut.push(['stability · unstable tests', String(n), `≤ ${st.max_unstable_tests}`, flag(n <= st.max_unstable_tests)]);
  }
  // Code-quality ceilings (counts; ⚠️ when over the max). null = tool didn't run.
  const q = latestQuality();
  const qt = TARGETS.quality || {};
  if (q) {
    const addMax = (label, val, max) =>
      max != null && rowsOut.push([label, val == null ? '—' : String(val), `≤ ${max}`, flag(val == null ? null : val <= max)]);
    addMax('quality · tsc errors', q.ts_errors, qt.ts_errors_max);
    addMax('quality · ruff', q.ruff, qt.ruff_errors_max);
    addMax('quality · shellcheck', q.shellcheck, qt.shellcheck_errors_max);
    addMax('quality · SAST critical', q.sast_critical, qt.sast_critical_max);
    addMax('quality · dep vulns (high+)', q.deps_high == null ? null : (q.deps_critical || 0) + q.deps_high, qt.deps_high_max);
    addMax('quality · leaked secrets', q.secrets, qt.secrets_max);
  }
  if (!rowsOut.length) return '';
  let t = '## Targets (SLOs)\n\n| Target | Current | Goal | |\n|---|--:|--:|:-:|\n';
  for (const r of rowsOut) t += `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |\n`;
  const breaches = rowsOut.filter((r) => r[3] === '⚠️').length;
  t += `\n${breaches === 0 ? '_All targets met._' : `_${breaches} target(s) breached — the QA Manager drives tickets to close these._`}\n`;
  return t + '\n';
}

function coverageSection() {
  const cov = (covRows().slice(-1)[0] || {}).coverage || null;
  if (!cov) return '';
  const e = cov.e2e || {};
  const u = cov.unit || null;
  let t = '## Coverage\n\n';
  t += '| Axis | Value | Detail |\n|---|--:|---|\n';
  t += `| e2e screens | ${pctStr(e.screens_pct)} | ${e.screens_covered}/${e.screens_total} navigable routes visited |\n`;
  t += `| e2e journeys | ${pctStr(e.journeys_pct)} | ${e.journeys_covered}/${e.journeys_total} canonical lifecycle steps${e.journeys_missing?.length ? ` · missing: ${e.journeys_missing.join(', ')}` : ''} |\n`;
  if (u) {
    t += `| unit lines | ${pctStr(u.lines)} | vitest v8 |\n`;
    t += `| unit branches | ${pctStr(u.branches)} | vitest v8 |\n`;
  }
  if (e.screens_uncovered?.length) {
    t += `\n_Uncovered screens:_ ${e.screens_uncovered.map((s) => `\`${s}\``).join(', ')}\n`;
  }
  return t + '\n';
}

function qualitySection() {
  const q = latestQuality();
  if (!q) return '';
  const n = (v) => (v == null ? '—' : String(v));
  let t = '## Code quality (static analysis)\n\n';
  t += '| Check | Findings |\n|---|--:|\n';
  t += `| TypeScript errors (\`tsc --noEmit\`) | ${n(q.ts_errors)} |\n`;
  if (q.eslint) t += `| ESLint | ${q.eslint.errors} errors · ${q.eslint.warnings} warnings |\n`;
  t += `| Ruff (Python lint) | ${n(q.ruff)} |\n`;
  t += `| ShellCheck | ${n(q.shellcheck)} |\n`;
  t += `| Hadolint (Dockerfile) | ${n(q.hadolint)} |\n`;
  t += `| Leaked secrets (gitleaks) | ${n(q.secrets)} |\n`;
  if (q.semgrep) t += `| Semgrep SAST | ${q.semgrep.total} (${q.semgrep.critical}C/${q.semgrep.high}H/${q.semgrep.medium}M) |\n`;
  if (q.codeql) t += `| CodeQL alerts | ${q.codeql.total} (${q.codeql.critical}C/${q.codeql.high}H) |\n`;
  if (q.deps) t += `| Dependency vulns | ${q.deps.critical}C/${q.deps.high}H/${q.deps.medium}M/${q.deps.low}L |\n`;
  return t + '\n';
}

function recentRunsTable() {
  const last = rows.slice(-20).reverse();
  let t = '| When (UTC) | Suite | Result | Pass | Fail | Skip | Duration | Commit | Run |\n';
  t += '|---|---|---|--:|--:|--:|--:|---|---|\n';
  for (const r of last) {
    const dur = r.stats?.duration_ms != null ? `${(r.stats.duration_ms / 1000).toFixed(1)}s` : '—';
    const commit = r.sha_short ? `\`${r.sha_short}\`` : '—';
    const run = r.run_url ? `[#${r.run_number ?? '↗'}](${r.run_url})` : '—';
    t += `| ${fmtTs(r.ts)} | \`${r.suite}\` | ${ICON[r.outcome] || ''} ${r.outcome} | ${r.stats?.expected ?? 0} | ${r.stats?.unexpected ?? 0} | ${r.stats?.skipped ?? 0} | ${dur} | ${commit} | ${run} |\n`;
  }
  return t;
}

function unstableTestsTable() {
  const unstable = flakiness(rows.slice(-120)).slice(0, 20);
  if (!unstable.length) return '_No failing or flaky tests in the recent window. 🎉_\n';
  let t = '| Test | Suite | Flips | Fails | Flakies | Flake-rate | Last |\n|---|---|--:|--:|--:|--:|---|\n';
  for (const a of unstable) {
    t += `| ${a.title.replace(/\|/g, '\\|')} | \`${a.suite}\` | ${a.flips} | ${a.fails} | ${a.flakies} | ${(a.flake_rate * 100).toFixed(0)}% | ${ICON[a.last] || a.last} |\n`;
  }
  return t + '\n_Flips = pass↔fail transitions across consecutive runs — a high flip count is the clearest flakiness signal._\n';
}

function buildReadme() {
  const latestAny = rows[rows.length - 1];
  return `# CI test trends — \`${esc(process.env.GITHUB_REPOSITORY || 'this repo')}\`

> Auto-generated by **PR Validation** (\`publish-test-history\`). Do not edit by hand — every
> run regenerates this branch. The machine-readable source of truth is [\`runs.jsonl\`](./runs.jsonl).
> Deployed-environment E2E trends live separately on the [\`e2e-history\`](../../tree/e2e-history) branch.

**Last updated:** ${fmtTs(latestAny?.ts)} · ${rows.length} records · suites: ${suiteOrder.map((s) => `\`${s}\``).join(', ') || '—'}

![trend](./trend.svg)

${targetsSection()}${coverageSection()}${qualitySection()}## Suites

${suiteSummaryTable()}

## Recent runs

${recentRunsTable()}

## Unstable tests (recent window)

${unstableTestsTable()}

---

### Reading this data programmatically

\`\`\`bash
# every line is one suite-run; newest last
git show ci-history:runs.jsonl | tail -n 20

# e.g. the unit suite's pass-rate over its last 50 runs
git show ci-history:runs.jsonl \\
  | jq -rs '[.[] | select(.suite=="unit")] | .[-50:]
            | (map(select(.outcome=="passed")) | length) / length * 100'
\`\`\`

Record shape: \`{ ts, suite, outcome, pass_rate, stats:{expected,unexpected,flaky,skipped,total,duration_ms}, run_url, sha_short, branch, trigger, tests:[{title,file,status,duration_ms}] }\`
`;
}

writeFileSync(join(dir, 'trend.svg'), buildSvg());
writeFileSync(join(dir, 'README.md'), buildReadme());
console.log(`rendered CI dashboard from ${rows.length} record(s) across ${suiteOrder.length} suite(s)`);
