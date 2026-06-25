// Doc-assertion tests for issue #41 — "Update README.md to reflect DIA Portal
// (DMS automotivo), not equipment rental".
//
// This is a DOCUMENTATION-only change: there is no app logic to exercise, so the
// right "test pyramid" is a single layer of deterministic, executable assertions
// over the committed README text + on-disk link targets. Each test maps back to an
// acceptance criterion in docs/specs/41-readme-automotivo.md and is designed to FAIL
// if the README regresses to the legacy rental narrative or grows a broken link.
//
// Zero dependencies — plain node:test + node:assert, matching the repo's existing
// harness (see supabase/tests/vehicle_crud.test.mjs).
//
// HOW TO RUN:
//   node --test docs/ship-issue/tests/readme-automotivo.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

// Repo root = three levels up from docs/ship-issue/tests/
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const README_PATH = join(REPO_ROOT, 'README.md')

const readme = readFileSync(README_PATH, 'utf8')
const lines = readme.split(/\r?\n/)

// Legacy rental terms that must NOT survive as live product narrative.
const FORBIDDEN_NARRATIVE = ['Equipment Rental', 'RentalMan', 'Wynne']

// AC#1 — Title no longer carries the rental narrative and names the automotive DMS.
test('AC1: first heading drops rental narrative and names the DIA Portal automotive DMS', () => {
  const firstHeading = lines.find((l) => l.startsWith('# '))
  assert.ok(firstHeading, 'README must have a top-level (#) heading')

  for (const term of FORBIDDEN_NARRATIVE) {
    assert.ok(
      !firstHeading.includes(term),
      `Title must not contain legacy term "${term}" — got: ${firstHeading}`,
    )
  }
  // Must identify the real product. "DMS" + ("DIA Portal" and/or "Automotive").
  assert.match(firstHeading, /DMS/i, `Title should mention "DMS" — got: ${firstHeading}`)
  assert.match(
    firstHeading,
    /DIA Portal|Automotive/i,
    `Title should mention "DIA Portal" or "Automotive" — got: ${firstHeading}`,
  )
})

// AC#2 / AC#3 — No stale rental narrative anywhere in the README, EXCEPT the two
// explicitly-annotated legacy artifacts (@dia-rental.dev, rental-app-frontend).
//
// We calibrate against the committed README: "Equipment Rental"/"RentalMan"/"Wynne"
// must be entirely absent (zero occurrences). The bare word "rental" may only appear
// inside the two legacy tokens, never as standalone product prose like "rental ERP".
test('AC2/AC3: no live equipment-rental narrative (RentalMan / Wynne / "Equipment Rental") remains', () => {
  for (const term of FORBIDDEN_NARRATIVE) {
    const hits = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => l.includes(term))
    assert.deepEqual(
      hits.map((h) => h.n),
      [],
      `Legacy term "${term}" must not appear at all; found at line(s): ${hits
        .map((h) => `${h.n}: ${h.l.trim()}`)
        .join(' | ')}`,
    )
  }
})

test('AC3: every standalone "rental" occurrence is part of an annotated legacy token, not product prose', () => {
  // Allowed legacy tokens that legitimately contain the substring "rental".
  const ALLOWED_TOKENS = ['dia-rental.dev', 'rental-app-frontend', 'rental-app']

  const offending = []
  const re = /rental/gi
  lines.forEach((line, idx) => {
    let m
    while ((m = re.exec(line)) !== null) {
      const start = m.index
      // Is this "rental" inside one of the allowed tokens on this line?
      const inAllowed = ALLOWED_TOKENS.some((tok) => {
        let from = 0
        while (true) {
          const ti = line.indexOf(tok, from)
          if (ti === -1) return false
          const rel = line.indexOf('rental', ti)
          if (rel !== -1 && rel >= ti && rel < ti + tok.length && rel === start) return true
          from = ti + 1
        }
      })
      if (!inAllowed) offending.push(`${idx + 1}: ${line.trim()}`)
    }
  })

  assert.deepEqual(
    offending,
    [],
    `"rental" may only appear inside legacy tokens (${ALLOWED_TOKENS.join(
      ', ',
    )}); product-narrative uses found at: ${offending.join(' | ')}`,
  )
})

// AC#2 — The automotive domain is actually described (positive assertion).
test('AC2: README describes the real automotive DMS domain (vehicles, service orders, parts, BI)', () => {
  const text = readme.toLowerCase()
  // vehicles / frota
  assert.ok(
    text.includes('vehicle') || text.includes('frota') || text.includes('veícul') || text.includes('veicul'),
    'README should mention vehicles / frota',
  )
  // service orders / ordem de serviço / oficina
  assert.ok(
    text.includes('service order') || text.includes('ordem de serviço') || text.includes('oficina'),
    'README should mention service orders / ordem de serviço / oficina',
  )
  // parts / peças
  assert.ok(
    text.includes('parts') || text.includes('peças') || text.includes('pecas'),
    'README should mention parts / peças',
  )
  // BI
  assert.match(readme, /\bBI\b/, 'README should mention BI (agentic BI analytics layer)')
})

// Extract every distinct relative internal link target from README text.
// Skips external (http/mailto/tel) and pure anchors; strips #anchor / :line suffixes.
function extractInternalLinks(md) {
  const linkRe = /\]\(([^)]+)\)/g
  const targets = new Set()
  let m
  while ((m = linkRe.exec(md)) !== null) {
    let target = m[1].trim()
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) continue
    target = target.replace(/^<|>$/g, '')
    target = target.split('#')[0]
    target = target.replace(/:\d+(-\d+)?$/, '')
    if (target === '') continue
    targets.add(target)
  }
  return [...targets]
}

function resolveTarget(target) {
  const cleaned = target.replace(/^\.\//, '')
  return resolve(REPO_ROOT, cleaned)
}

// KNOWN pre-existing broken links that this change (#41) neither introduced nor was
// scoped to fix. Verified against 7646263^ (the parent commit): all four were already
// broken before the README reframing. They live in the "Test trends" section, which
// the #41 diff did NOT touch, and they point at workflows that currently exist only
// under .github/workflows.disabled/ (not the active .github/workflows/). The spec
// (docs/specs/41-readme-automotivo.md, AC#5 + Non-Goals) scopes #41 to the narrative
// + directly-cited docs only, so fixing these is explicitly out of scope / follow-up.
// This allowlist keeps the whole-file audit honest: any NEW broken link still fails.
const KNOWN_PREEXISTING_BROKEN = new Set([
  './.github/workflows/e2e-dev.yml',
  './.github/workflows/visual-ux.yml',
  './.github/workflows/pr-validation.yml',
  './.github/workflows/code-quality.yml',
])

// AC#5 (load-bearing regression guard) — every relative internal link resolves on
// disk, EXCEPT the documented pre-existing broken set above. This is the test that
// guards criterion #5: the issue's original broken link (equipment-rental-domain-model)
// would re-surface here, and any newly-introduced broken link fails the build.
test('AC5: every relative internal markdown link resolves on disk (minus documented pre-existing breakage)', () => {
  const links = extractInternalLinks(readme)
  const broken = links.filter((t) => !existsSync(resolveTarget(t)))
  const unexpected = broken.filter((t) => !KNOWN_PREEXISTING_BROKEN.has(t))

  // Sanity: the audit must actually have work to do, otherwise it is vacuous.
  assert.ok(links.length >= 20, `Expected many internal links; only saw ${links.length}`)
  assert.deepEqual(
    unexpected,
    [],
    `Unexpected broken internal link target(s) in README (not in the documented pre-existing set):\n  ${unexpected
      .map((t) => `${t}  →  ${resolveTarget(t)}`)
      .join('\n  ')}`,
  )
})

// AC#5 (scoped guarantee) — every internal link in the sections #41 actually rewrote
// MUST resolve. These are the spec's changed lines (AC#3): the title/intro, the domain
// section, the stack/repo/testing/docs tables. None may regress to a broken target.
// Calibrated by checking each known link the diff added/edited; the originally-broken
// equipment-rental-domain-model link was in this set and is asserted gone separately.
test('AC5 (scoped): every internal link added/edited by this change resolves on disk', () => {
  const changedSectionLinks = [
    './docs/discovery/domain/README.md',
    './docs/discovery/README.md',
    './docs/specs/4-vehicle-crud.md',
    './docs/specs/7-feat-ordem-de-servico-oficina.md',
    './docs/specs/8-feat-pecas-entidade-crud.md',
    './docs/architecture/data-model.md',
    './docs/architecture/product-architecture.md',
    './docs/specs/', // directory link
    './docs/specs/software-creation-factory.md',
    './docs/specs/live-cluster-deploy-smoke-rollback.md',
    './docs/specs/operations-factory-agentic-workflows.md',
    './frontend-portal/',
    './temporal/',
    './temporal/tests/',
    './docs/user-guide/README.md',
  ]
  // Guard: each of these must actually be referenced in the current README, so the
  // list can't silently drift away from reality.
  for (const link of changedSectionLinks) {
    assert.ok(
      readme.includes(`(${link})`),
      `Expected README to reference "${link}" in a changed section — it no longer does (update this test)`,
    )
    assert.ok(
      existsSync(resolveTarget(link)),
      `Link in a #41-changed section does not resolve on disk: ${link}`,
    )
  }
})

// AC#5 (regression guard) — the specific link the issue flagged as broken must be gone.
test('AC5: the missing-file link to equipment-rental-domain-model.md is no longer referenced', () => {
  assert.ok(
    !readme.includes('equipment-rental-domain-model'),
    'README must not link to docs/specs/equipment-rental-domain-model.md (the originally broken reference)',
  )
})

// AC#4 — @dia-rental.dev demo emails, if present, must be annotated as a legacy
// placeholder near where they appear.
test('AC4: @dia-rental.dev demo accounts are annotated as a legacy placeholder', () => {
  if (!readme.includes('@dia-rental.dev')) return // acceptable: corrected away entirely

  const firstUse = lines.findIndex((l) => l.includes('@dia-rental.dev'))
  assert.ok(firstUse !== -1)

  // A legacy/annotation note must exist (anywhere in the doc, and specifically tying
  // dia-rental.dev to "legacy"). Calibrated to the committed note wording.
  const noteRe = /dia-rental\.dev[\s\S]{0,400}legacy|legacy[\s\S]{0,400}dia-rental\.dev/i
  assert.match(
    readme,
    noteRe,
    'A "legacy placeholder" annotation must accompany the @dia-rental.dev demo emails',
  )
})

// AC#6 — rental-app-frontend service name, if it must remain, is annotated as legacy
// and tied to the current DIA Portal frontend.
test('AC6: rental-app-frontend service reference, if present, is annotated as legacy', () => {
  if (!readme.includes('rental-app-frontend')) return // acceptable: replaced with frontend-portal

  // Annotation must explain it's the legacy release name and points at the real app.
  const annotationRe = /rental-app-frontend[\s\S]{0,400}(legacy|frontend-portal|DIA Portal)|(legacy release|frontend-portal)[\s\S]{0,400}rental-app-frontend/i
  assert.match(
    readme,
    annotationRe,
    'rental-app-frontend must be annotated (legacy release name) and tied to the DIA Portal frontend',
  )
})
