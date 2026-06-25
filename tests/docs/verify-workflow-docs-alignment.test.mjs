import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const ACTIVE_WORKFLOWS_DIR = '.github/workflows'
const DISABLED_WORKFLOWS_DIR = '.github/workflows.disabled'

const WORKFLOW_FILE_RE = /\.ya?ml$/i
const REQUIRED_DISABLED_STATE_DOCS = [
  'MONITORING.md',
  'OPERATIONS.md',
  'docs/architecture/ci-cd-pipelines.md',
]

const DOCS_TO_SCAN_FOR_CADENCE_CLAIMS = [
  'README.md',
  'MONITORING.md',
  'OPERATIONS.md',
  'docs/architecture/README.md',
  'docs/architecture/ci-cd-pipelines.md',
  'docs/architecture/deployment.md',
  'docs/architecture/operations-factory.md',
  'docs/architecture/software-factory.md',
]

const ADRS_WITH_CURRENT_STATUS_NOTES = [
  'docs/adrs/0006-autonomous-software-factory.md',
  'docs/adrs/0018-real-environment-e2e.md',
  'docs/adrs/0025-agent-cadence-pipelines.md',
  'docs/adrs/0028-user-docs-manager-lane.md',
  'docs/adrs/0033-project-manager-owns-per-pr-pipeline-loop.md',
  'docs/adrs/0039-alertmanager-incident-bridge.md',
  'docs/adrs/0064-non-gating-quality-and-ux-observability-lanes.md',
  'docs/adrs/0070-daily-roadmap-curator-workflow-gh-cli-direct.md',
  'docs/adrs/0098-actions-monitor-uses-job-timeout-budget-before-hang-escalation.md',
]

const CADENCE_RUN_CLAIM_RE = new RegExp(
  [
    String.raw`\bruns?\s+(?:automatically\s+)?(?:hourly|nightly|daily|weekly)\b`,
    String.raw`\bruns?\s+(?:on\s+)?(?:an?\s+)?scheduled\s+(?:cadence|pipeline|run|workflow)s?\b`,
    String.raw`\bruns?\s+(?:on|after)\s+every\s+(?:merge|dev\s+deploy|hour|night|day|week)\b`,
    String.raw`\bruns?\s+on\s+(?:PRs?|pushes|schedules?|workflow_run|cron)\b`,
    String.raw`\bexecutes?\s+(?:automatically\s+)?(?:hourly|nightly|daily|weekly)\b`,
    String.raw`\btriggers?\s+(?:automatically\s+)?(?:hourly|nightly|daily|weekly)\b`,
    String.raw`\brod(?:a|am)\s+(?:automaticamente\s+)?(?:de\s+hora\s+em\s+hora|diariamente|toda\s+noite|todas\s+as\s+noites|semanalmente|por\s+merge)\b`,
    String.raw`\bexecut(?:a|am)\s+(?:automaticamente\s+)?(?:de\s+hora\s+em\s+hora|diariamente|toda\s+noite|todas\s+as\s+noites|semanalmente|por\s+merge)\b`,
  ].join('|'),
  'i',
)

const QUALIFIED_DISABLED_CONTEXT_RE = /\b(disabled|parked|workflows\.disabled|reactivat(?:e|ed|ion)|desativad[ao]s?|estacionad[ao]s?|quando\s+reativ|do\s+not\s+run|does\s+not\s+run|not\s+run|inactive|inativ[ao]s?|parad[ao]s?)\b/i

function workflowFiles(dir) {
  assert.ok(existsSync(dir), `expected workflow directory to exist: ${dir}`)
  return readdirSync(dir).filter((name) => WORKFLOW_FILE_RE.test(name)).sort()
}

function readDoc(path) {
  assert.ok(existsSync(path), `expected documentation file to exist: ${path}`)
  return readFileSync(path, 'utf8')
}

test('AC: ci.yml is the only active GitHub Actions workflow', () => {
  const activeWorkflows = workflowFiles(ACTIVE_WORKFLOWS_DIR)
  const disabledWorkflows = workflowFiles(DISABLED_WORKFLOWS_DIR)

  assert.deepEqual(
    activeWorkflows,
    ['ci.yml'],
    'docs must be re-checked whenever a workflow besides ci.yml becomes active',
  )
  assert.ok(disabledWorkflows.length > 0, 'expected parked workflows under .github/workflows.disabled/')
  assert.ok(
    !disabledWorkflows.includes('ci.yml'),
    'ci.yml must remain active, not parked under .github/workflows.disabled/',
  )
})

test('AC: core operations docs acknowledge parked workflows.disabled state', () => {
  for (const docPath of REQUIRED_DISABLED_STATE_DOCS) {
    assert.match(
      readDoc(docPath),
      /workflows\.disabled/,
      `${docPath} must explicitly mention .github/workflows.disabled/`,
    )
  }
})

test('AC: CI/CD architecture doc accounts for every parked workflow file', () => {
  const ciCdDoc = readDoc('docs/architecture/ci-cd-pipelines.md')

  for (const parkedWorkflow of workflowFiles(DISABLED_WORKFLOWS_DIR)) {
    assert.ok(
      ciCdDoc.includes(parkedWorkflow),
      `docs/architecture/ci-cd-pipelines.md must acknowledge parked workflow ${parkedWorkflow}`,
    )
  }
})

test('AC: cadence claims in live architecture and operations docs are qualified as disabled or reactivation-only', () => {
  for (const docPath of DOCS_TO_SCAN_FOR_CADENCE_CLAIMS) {
    const lines = readDoc(docPath).split('\n')

    lines.forEach((line, index) => {
      if (!CADENCE_RUN_CLAIM_RE.test(line)) return

      const nearbyContext = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
      assert.match(
        nearbyContext,
        QUALIFIED_DISABLED_CONTEXT_RE,
        `${docPath}:${index + 1} has an unqualified automatic cadence claim: ${line.trim()}`,
      )
    })
  }
})


test('AC: ADRs that describe parked workflow behavior carry an explicit current-status note', () => {
  for (const docPath of ADRS_WITH_CURRENT_STATUS_NOTES) {
    const statusPreamble = readDoc(docPath).split('\n').slice(0, 12).join('\n')

    assert.match(
      statusPreamble,
      /Status atual|Current status/i,
      `${docPath} must keep a current-status preamble before historical ADR text`,
    )
    assert.match(
      statusPreamble,
      /workflows\.disabled/,
      `${docPath} current-status preamble must mention .github/workflows.disabled/`,
    )
    assert.match(
      statusPreamble,
      /do\s+not\s+run|does\s+not\s+run|não\s+rod|nao\s+rod|disabled|parked/i,
      `${docPath} current-status preamble must say the workflow does not run automatically today`,
    )
  }
})
