from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RECORD_SCRIPT = REPO_ROOT / ".github" / "scripts" / "e2e-history-record.mjs"
RENDER_SCRIPT = REPO_ROOT / ".github" / "scripts" / "e2e-history-render.mjs"
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "e2e-dev.yml"
ALERT_CLIENT_PATH = REPO_ROOT / ".github" / "tools" / "shared" / "src" / "alert-github-client.ts"


def _run_record_script(*, suite: str, results_path: Path, env: dict[str, str]) -> dict[str, object]:
    proc = subprocess.run(
        ["node", str(RECORD_SCRIPT), "--suite", suite, "--results", str(results_path)],
        text=True,
        capture_output=True,
        check=True,
        env={**os.environ, **env},
        cwd=REPO_ROOT,
        timeout=60.0,
    )
    return json.loads(proc.stdout.strip())


def test_record_script_converts_playwright_json_to_expected_history_shape(tmp_path: Path) -> None:
    results = {
        "stats": {
            "startTime": "2026-06-07T11:22:33.987Z",
            "duration": 3210,
            "expected": 2,
            "unexpected": 1,
            "flaky": 1,
            "skipped": 1,
        },
        "suites": [
            {
                "file": "frontend/e2e/smoke.spec.ts",
                "specs": [
                    {"title": "home renders", "tests": [{"status": "expected", "results": [{"duration": 120}]}]},
                    {"title": "orders load", "tests": [{"status": "unexpected", "results": [{"duration": 350}]}]},
                    {"title": "retry path", "tests": [{"status": "flaky", "results": [{"duration": 110}, {"duration": 140}]}]},
                    {"title": "skipped path", "tests": [{"status": "skipped", "results": []}]},
                ],
            }
        ],
    }
    results_path = tmp_path / "e2e-results.json"
    results_path.write_text(json.dumps(results))

    record = _run_record_script(
        suite="smoke",
        results_path=results_path,
        env={
            "GITHUB_SERVER_URL": "https://github.example",
            "GITHUB_REPOSITORY": "Volaris-AI/dia",
            "GITHUB_RUN_ID": "1234",
            "GITHUB_RUN_NUMBER": "56",
            "GITHUB_SHA": "0123456789abcdef0123456789abcdef01234567",
            "GITHUB_REF_NAME": "main",
            "GITHUB_EVENT_NAME": "workflow_run",
            "E2E_BASE_URL": "https://dia.dev/",
        },
    )

    assert record["suite"] == "smoke"
    assert record["outcome"] == "failed"
    assert record["ts"] == "2026-06-07T11:22:33.987Z"
    assert record["pass_rate"] == 0.75
    assert record["stats"] == {
        "expected": 2,
        "unexpected": 1,
        "flaky": 1,
        "skipped": 1,
        "total": 5,
        "duration_ms": 3210,
    }
    assert record["run_url"] == "https://github.example/Volaris-AI/dia/actions/runs/1234"
    assert record["sha_short"] == "0123456"
    assert record["tests"] == [
        {"title": "home renders", "file": "frontend/e2e/smoke.spec.ts", "status": "passed", "duration_ms": 120},
        {"title": "orders load", "file": "frontend/e2e/smoke.spec.ts", "status": "failed", "duration_ms": 350},
        {"title": "retry path", "file": "frontend/e2e/smoke.spec.ts", "status": "flaky", "duration_ms": 250},
        {"title": "skipped path", "file": "frontend/e2e/smoke.spec.ts", "status": "skipped", "duration_ms": 0},
    ]


def test_record_script_marks_unparseable_results_as_error(tmp_path: Path) -> None:
    bad_results = tmp_path / "e2e-results.json"
    bad_results.write_text("{not-json")

    record = _run_record_script(
        suite="experience",
        results_path=bad_results,
        env={"RUN_TS": "2026-06-07T00:00:00.000Z"},
    )

    assert record["suite"] == "experience"
    assert record["outcome"] == "error"
    assert record["pass_rate"] is None
    assert record["stats"] == {
        "expected": 0,
        "unexpected": 0,
        "flaky": 0,
        "skipped": 0,
        "total": 0,
        "duration_ms": None,
    }
    assert record["tests"] == []
    assert isinstance(record.get("error"), str) and record["error"]


def test_record_script_marks_report_with_errors_array_as_error(tmp_path: Path) -> None:
    results = {
        "stats": {
            "startTime": "2026-06-07T12:00:00.000Z",
            "duration": 0,
            "expected": 0,
            "unexpected": 0,
            "flaky": 0,
            "skipped": 0,
        },
        "errors": [{"message": "SyntaxError: Cannot find module './missing-import'"}],
        "suites": [],
    }
    results_path = tmp_path / "e2e-results.json"
    results_path.write_text(json.dumps(results))

    record = _run_record_script(
        suite="experience",
        results_path=results_path,
        env={"RUN_TS": "2026-06-07T00:00:00.000Z"},
    )

    assert record["suite"] == "experience"
    assert record["outcome"] == "error"
    assert record["pass_rate"] is None
    assert record["stats"]["total"] == 0
    assert record["tests"] == []
    assert isinstance(record.get("error"), str) and "SyntaxError" in record["error"]


def test_record_script_marks_zero_test_report_as_error(tmp_path: Path) -> None:
    results = {
        "stats": {
            "startTime": "2026-06-07T12:00:00.000Z",
            "duration": 500,
            "expected": 0,
            "unexpected": 0,
            "flaky": 0,
            "skipped": 0,
        },
        "errors": [],
        "suites": [],
    }
    results_path = tmp_path / "e2e-results.json"
    results_path.write_text(json.dumps(results))

    record = _run_record_script(
        suite="experience",
        results_path=results_path,
        env={"RUN_TS": "2026-06-07T00:00:00.000Z"},
    )

    assert record["suite"] == "experience"
    assert record["outcome"] == "error"
    assert record["pass_rate"] is None
    assert record["stats"] == {
        "expected": 0,
        "unexpected": 0,
        "flaky": 0,
        "skipped": 0,
        "total": 0,
        "duration_ms": 500,
    }
    assert record["tests"] == []


def test_render_script_builds_readme_and_trend_with_unstable_failures(tmp_path: Path) -> None:
    rows = [
        {
            "ts": "2026-06-06T10:00:00.000Z",
            "suite": "smoke",
            "outcome": "passed",
            "pass_rate": 1.0,
            "stats": {"unexpected": 0, "flaky": 0, "duration_ms": 1000},
            "run_url": "https://example/runs/1",
            "run_number": 1,
            "sha_short": "aaaaaaa",
            "base_url": "https://dia.dev/",
            "tests": [{"title": "home renders", "status": "passed", "duration_ms": 10}],
        },
        {
            "ts": "2026-06-06T11:00:00.000Z",
            "suite": "experience",
            "outcome": "failed",
            "pass_rate": 0.5,
            "stats": {"unexpected": 1, "flaky": 1, "duration_ms": 2000},
            "run_url": "https://example/runs/2",
            "run_number": 2,
            "sha_short": "bbbbbbb",
            "base_url": "https://dia.dev/",
            "tests": [
                {"title": "dashboard KPI useful", "status": "failed", "duration_ms": 20},
                {"title": "filter retains selection", "status": "flaky", "duration_ms": 30},
            ],
        },
        {
            "ts": "2026-06-06T12:00:00.000Z",
            "suite": "smoke",
            "outcome": "failed",
            "pass_rate": 0.66,
            "stats": {"unexpected": 1, "flaky": 0, "duration_ms": 4000},
            "run_url": "https://example/runs/3",
            "run_number": 3,
            "sha_short": "ccccccc",
            "base_url": "https://dia.dev/",
            "tests": [{"title": "home renders", "status": "failed", "duration_ms": 15}],
        },
    ]
    (tmp_path / "runs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))

    subprocess.run(
        ["node", str(RENDER_SCRIPT), str(tmp_path)],
        text=True,
        capture_output=True,
        check=True,
        env={**os.environ, "GITHUB_REPOSITORY": "Volaris-AI/dia"},
        cwd=REPO_ROOT,
        timeout=60.0,
    )

    trend = (tmp_path / "trend.svg").read_text()
    readme = (tmp_path / "README.md").read_text()

    assert "Pass rate (last 60 runs)" in trend
    assert "red dot = failing run" in trend

    assert "# E2E trends — `Volaris-AI/dia`" in readme
    assert "**Latest smoke:** ❌ `failed`" in readme
    assert "| Total runs recorded | 3 |" in readme
    assert "## Unstable tests (recent window)" in readme
    # Unstable-tests table now carries flip-flop columns: Flips | Fails | Flakies | Flake-rate | Last
    assert "| dashboard KPI useful | experience | 0 | 1 | 0 | 100% | ❌ |" in readme
    assert "| filter retains selection | experience | 0 | 0 | 1 | 100% | flaky |" in readme


def test_e2e_workflow_publish_history_is_always_non_gating_after_all_prerequisite_suites() -> None:
    text = WORKFLOW_PATH.read_text()
    match = re.search(r"(?ms)^  publish-history:\n(?P<body>(?:^    .*\n)+)", text)
    assert match, "publish-history job block is required in .github/workflows/e2e-dev.yml"
    body = match.group("body")
    assert "needs: [e2e, entity-drilldown, experience]" in body
    assert "if: always()" in body


def test_e2e_failure_sentinel_keeps_priority_and_fingerprint_contract() -> None:
    """Workflow-level regression contract for the e2e-failure-sentinel paths (issue #2068).

    Asserts that .github/workflows/e2e-dev.yml preserves:
    - ``--labels priority:high`` on the shared-CLI incident step.
    - ``priority:high`` and ``<!-- fingerprint:e2e-dev-failure -->`` on the gh-fallback step.
    - Strongly consistent list/body dedupe (``gh api --paginate`` + local jq scan, not ``--search``).
    - Oldest-match selection via ``min_by(.number)`` to avoid duplicate incidents.
    - Least-privilege ``github.token`` (not ``PROJECT_MANAGER_PAT``) on both paths.

    This test fails if any of these sentinel-wiring contracts regress in the YAML.
    """
    text = WORKFLOW_PATH.read_text()

    shared_step = re.search(r"(?ms)^      - name: File / update E2E incident\n(?P<body>(?:^        .*\n)+)", text)
    assert shared_step, "e2e-failure-sentinel shared-CLI step must exist in .github/workflows/e2e-dev.yml"
    shared_body = shared_step.group("body")
    assert "--labels priority:high" in shared_body
    assert "GH_TOKEN: ${{ github.token }}" in shared_body
    assert "PROJECT_MANAGER_PAT" not in shared_body

    fallback_step = re.search(
        r"(?ms)^      - name: File / update E2E incident \(gh fallback\)\n(?P<body>(?:^        .*\n)+)",
        text,
    )
    assert fallback_step, "e2e-failure-sentinel gh fallback step must exist in .github/workflows/e2e-dev.yml"
    fallback_body = fallback_step.group("body")
    assert "GH_TOKEN: ${{ github.token }}" in fallback_body
    assert "PROJECT_MANAGER_PAT" not in fallback_body
    assert "priority:high" in fallback_body
    assert "<!-- fingerprint:e2e-dev-failure -->" in fallback_body
    assert "--search \"fingerprint:e2e-dev-failure\"" not in fallback_body
    assert "gh api --paginate --repo \"${GITHUB_REPOSITORY}\"" in fallback_body
    assert "jq -sr --arg fp \"$FP\"" in fallback_body
    assert "select((.pull_request | not)" in fallback_body
    assert "contains($fp)" in fallback_body
    assert "min_by(.number).number" in fallback_body


def test_shared_incident_helper_uses_list_body_fingerprint_contract() -> None:
    """Shared runtime contract: alert-github-client.ts must use the list/body fingerprint path.

    Asserts that the shared incident helper in .github/tools/shared/src/alert-github-client.ts
    deduplications via the strongly consistent REST list API (paginated issues, body scan) rather
    than the eventually consistent search index. Guards against regression to /search/issues.
    """
    text = ALERT_CLIENT_PATH.read_text()
    assert "/search/issues" not in text
    assert "/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}" in text
    assert "const marker = `<!-- ${searchToken} -->`;" in text
    assert 'if ("pull_request" in issue) continue;' in text
    assert "[...matches].sort((a, b) => a.number - b.number)" in text
