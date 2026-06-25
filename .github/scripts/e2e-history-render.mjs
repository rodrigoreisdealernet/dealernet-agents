#!/usr/bin/env node
// Render the human-facing dashboard from runs.jsonl.
//
// Reads the append-only history feed and writes, alongside it:
//   - trend.svg   a dependency-free trend chart (pass-rate + duration)
//   - README.md   a summary that renders directly in GitHub's web UI
//
// Usage: node e2e-history-render.mjs <history-dir>   (defaults to cwd)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTargets, flag, pctStr, flakiness, meanSkipPct, unstableCount } from './qa-targets.mjs';

const TARGETS = loadTargets();

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

const SUITES = ['smoke', 'experience'];
const bySuite = (s) => rows.filter((r) => r.suite === s);

// ----------------------------------------------------------------------------- SVG
const W = 920;
const PAD = { l: 56, r: 16, t: 28, b: 46 };
const PANEL_H = 150;
const GAP = 40;
const H = PAD.t + PANEL_H + GAP + PANEL_H + PAD.b;
const PLOT_W = W - PAD.l - PAD.r;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function path(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

// Inline presentation attributes (not a <style> block): GitHub's markdown image
// proxy strips <style> from embedded SVGs, so styling must live on each element.
const TITLE_ATTR = 'font-size="12" font-weight="600" fill="#1f2328"';
const YLAB_ATTR = 'font-size="10" fill="#656d76" text-anchor="end"';
const GRID_ATTR = 'stroke="#e1e4e8" stroke-width="1"';

function panel(title, top, series, yMin, yMax, fmtY) {
  const x = (i, n) => PAD.l + (n <= 1 ? PLOT_W / 2 : (PLOT_W * i) / (n - 1));
  const y = (v) => top + PANEL_H - ((v - yMin) / (yMax - yMin || 1)) * PANEL_H;
  let s = `<text x="${PAD.l}" y="${top - 8}" ${TITLE_ATTR}>${esc(title)}</text>`;
  // gridlines + y labels (4 steps)
  for (let g = 0; g <= 4; g++) {
    const v = yMin + ((yMax - yMin) * g) / 4;
    const yy = y(v);
    s += `<line x1="${PAD.l}" y1="${yy.toFixed(1)}" x2="${W - PAD.r}" y2="${yy.toFixed(1)}" ${GRID_ATTR}/>`;
    s += `<text x="${PAD.l - 8}" y="${(yy + 3).toFixed(1)}" ${YLAB_ATTR}>${esc(fmtY(v))}</text>`;
  }
  for (const ser of series) {
    const pts = ser.values.map((v, i) => [x(i, ser.values.length), y(v)]);
    if (pts.length === 1) {
      s += `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3" fill="${ser.color}"/>`;
    } else if (pts.length > 1) {
      s += `<path d="${path(pts)}" fill="none" stroke="${ser.color}" stroke-width="2"/>`;
    }
    // mark failing runs in red dots when provided
    (ser.marks || []).forEach((m, i) => {
      if (m) s += `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="2.6" fill="#d1242f"/>`;
    });
  }
  return s;
}

function buildSvg() {
  const N = 60; // last N runs per suite
  const smoke = bySuite('smoke').slice(-N);
  const exp = bySuite('experience').slice(-N);

  // Panel 1: pass-rate %
  const p1series = [];
  if (smoke.length) {
    p1series.push({
      color: '#1f883d',
      values: smoke.map((r) => (r.pass_rate ?? 0) * 100),
      marks: smoke.map((r) => r.outcome !== 'passed'),
    });
  }
  if (exp.length) {
    p1series.push({ color: '#bf8700', values: exp.map((r) => (r.pass_rate ?? 0) * 100) });
  }

  // Panel 2: run duration (seconds) for smoke
  const durSeries = smoke.length
    ? [{ color: '#0969da', values: smoke.map((r) => (r.stats?.duration_ms ?? 0) / 1000) }]
    : [];
  const maxDur = Math.max(1, ...durSeries.flatMap((s) => s.values));

  const top1 = PAD.t;
  const top2 = PAD.t + PANEL_H + GAP;

  const body =
    (p1series.length
      ? panel('Pass rate (last 60 runs) — green smoke, amber experience, red dot = failing run', top1, p1series, 0, 100, (v) => `${Math.round(v)}%`)
      : `<text x="${PAD.l}" y="${top1 + 70}" font-size="13" fill="#8b949e">no data yet</text>`) +
    (durSeries.length
      ? panel('Smoke run duration (seconds)', top2, durSeries, 0, maxDur, (v) => `${Math.round(v)}s`)
      : `<text x="${PAD.l}" y="${top2 + 70}" font-size="13" fill="#8b949e">no data yet</text>`);

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
  // consecutive trailing passes
  let n = 0;
  for (let i = suiteRows.length - 1; i >= 0; i--) {
    if (suiteRows[i].outcome === 'passed') n++;
    else break;
  }
  return n;
}

function recentRunsTable() {
  const last = rows.slice(-15).reverse();
  let t = '| When (UTC) | Suite | Result | Failed | Flaky | Skipped | Duration | Commit | Run |\n';
  t += '|---|---|---|--:|--:|--:|--:|---|---|\n';
  for (const r of last) {
    const dur = r.stats?.duration_ms != null ? `${(r.stats.duration_ms / 1000).toFixed(1)}s` : '—';
    const commit = r.sha_short ? `\`${r.sha_short}\`` : '—';
    const run = r.run_url ? `[#${r.run_number ?? '↗'}](${r.run_url})` : '—';
    t += `| ${fmtTs(r.ts)} | ${r.suite} | ${ICON[r.outcome] || ''} ${r.outcome} | ${r.stats?.unexpected ?? 0} | ${r.stats?.flaky ?? 0} | ${r.stats?.skipped ?? 0} | ${dur} | ${commit} | ${run} |\n`;
  }
  return t;
}

function unstableTestsTable() {
  const unstable = flakiness(rows.slice(-80)).slice(0, 15);
  if (!unstable.length) return '_No failing or flaky tests in the recent window. 🎉_\n';
  let t = '| Test | Suite | Flips | Fails | Flakies | Flake-rate | Last |\n|---|---|--:|--:|--:|--:|---|\n';
  for (const a of unstable) {
    t += `| ${a.title.replace(/\|/g, '\\|')} | ${a.suite} | ${a.flips} | ${a.fails} | ${a.flakies} | ${(a.flake_rate * 100).toFixed(0)}% | ${ICON[a.last] || a.last} |\n`;
  }
  return t + '\n_Flips = pass↔fail transitions across consecutive runs — the clearest flakiness signal._\n';
}

// --- Targets / SLO breach flags (from .github/qa-targets.json) ---
function targetsSection() {
  if (!TARGETS) return '';
  const pr = TARGETS.pass_rate || {};
  const st = TARGETS.stability || {};
  const out = [];
  for (const suite of ['smoke', 'experience']) {
    const cfg = pr[suite];
    if (!cfg || cfg.gating === false) continue; // experience is non-gating: no floor
    const sr = bySuite(suite);
    const win = passRateOver(sr, 7 * 24 * 3600e3);
    const val = win.pct == null ? null : win.pct / 100;
    out.push([`pass rate · \`${suite}\` (7d)`, val == null ? '—' : `${win.pct}%`, `≥ ${pctStr(cfg.min)}`, flag(val == null ? null : val >= cfg.min)]);
  }
  if (st.max_skip_pct != null) {
    const sk = meanSkipPct(bySuite('smoke').slice(-20));
    out.push(['stability · smoke skip%', pctStr(sk), `≤ ${pctStr(st.max_skip_pct)}`, flag(sk == null ? null : sk <= st.max_skip_pct)]);
  }
  if (st.max_unstable_tests != null) {
    const n = unstableCount(rows.slice(-80));
    out.push(['stability · unstable tests', String(n), `≤ ${st.max_unstable_tests}`, flag(n <= st.max_unstable_tests)]);
  }
  if (!out.length) return '';
  let t = '## Targets (SLOs)\n\n| Target | Current | Goal | |\n|---|--:|--:|:-:|\n';
  for (const r of out) t += `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |\n`;
  const breaches = out.filter((r) => r[3] === '⚠️').length;
  t += `\n${breaches === 0 ? '_All targets met._' : `_${breaches} target(s) breached — the QA Manager drives tickets to close these._`}\n\n`;
  return t;
}

function passRateOver(suiteRows, sinceMs) {
  const cut = rows.length ? Date.parse(rows[rows.length - 1].ts || '') - sinceMs : 0;
  const win = suiteRows.filter((r) => Date.parse(r.ts || '') >= cut);
  const passed = win.filter((r) => r.outcome === 'passed').length;
  return win.length ? { pct: Math.round((passed / win.length) * 100), n: win.length } : { pct: null, n: 0 };
}

function buildReadme() {
  const smoke = bySuite('smoke');
  const latestSmoke = smoke[smoke.length - 1];
  const latestAny = rows[rows.length - 1];
  const day = passRateOver(smoke, 24 * 3600e3);
  const week = passRateOver(smoke, 7 * 24 * 3600e3);

  const head = latestSmoke
    ? `**Latest smoke:** ${ICON[latestSmoke.outcome] || ''} \`${latestSmoke.outcome}\` · ${fmtTs(latestSmoke.ts)} · [run](${latestSmoke.run_url || '#'})`
    : '_No smoke runs recorded yet._';

  return `# E2E trends — \`${esc(process.env.GITHUB_REPOSITORY || 'this repo')}\`

> Auto-generated by the **E2E (dev environment)** workflow. Do not edit by hand — every
> run regenerates this branch. The machine-readable source of truth is [\`runs.jsonl\`](./runs.jsonl).

${head}

| Metric | Value |
|---|---|
| Smoke pass rate (24h) | ${day.pct == null ? '—' : `${day.pct}% (${day.n} runs)`} |
| Smoke pass rate (7d) | ${week.pct == null ? '—' : `${week.pct}% (${week.n} runs)`} |
| Current green streak | ${smoke.length ? `${streak(smoke)} runs` : '—'} |
| Total runs recorded | ${rows.length} |
| Target | \`${esc(latestAny?.base_url || 'n/a')}\` |
| Last updated | ${fmtTs(latestAny?.ts)} |

![trend](./trend.svg)

${targetsSection()}## Recent runs

${recentRunsTable()}

## Unstable tests (recent window)

${unstableTestsTable()}

---

### Reading this data programmatically

\`\`\`bash
# every line is one suite-run; newest last
git show e2e-history:runs.jsonl | tail -n 20

# e.g. smoke pass-rate over the last 50 runs
git show e2e-history:runs.jsonl \\
  | jq -rs '[.[] | select(.suite=="smoke")] | .[-50:]
            | (map(select(.outcome=="passed")) | length) / length * 100'
\`\`\`

Record shape: \`{ ts, suite, outcome, pass_rate, stats:{expected,unexpected,flaky,skipped,total,duration_ms}, run_url, sha_short, trigger, base_url, tests:[{title,file,status,duration_ms}] }\`
`;
}

writeFileSync(join(dir, 'trend.svg'), buildSvg());
writeFileSync(join(dir, 'README.md'), buildReadme());
console.log(`rendered dashboard from ${rows.length} record(s)`);
