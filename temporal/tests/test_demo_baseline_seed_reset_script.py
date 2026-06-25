from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_demo_baseline_seed_reset.sh"
RENTAL_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_rental_master_data_foundation_reset.sh"
RENTAL_ORDER_CONTRACT_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_rental_order_contract_reset.sh"
DRIVER_DISPATCH_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_driver_dispatch_execution_reset.sh"
DRIVER_RUNSHEET_CONTACT_FIELDS_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_driver_runsheet_contact_fields_reset.sh"
)
DISPATCH_LIVE_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_dispatch_live_ops_reset.sh"
LOGISTICS_COMPLIANCE_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_logistics_compliance_surface_reset.sh"
MULESOFT_DELIVERY_OBS_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_mulesoft_delivery_observability_reset.sh"
INTEGRATION_CONFIG_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_integration_config_reset.sh"
SMARTEQUIP_DELIVERY_OBS_RESET_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_smartequip_delivery_observability_reset.sh"
DESCARTES_SYNC_CONTROLS_RESET_SCRIPT_PATH = REPO_ROOT / "supabase" / "tests" / "run_descartes_sync_controls_reset.sh"
BILLTRUST_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_billtrust_observability_reconciliation_reset.sh"
)
INSPECTION_CHECKLIST_TEMPLATES_RESET_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_inspection_checklist_templates_reset.sh"
)
VISIONLINK_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_visionlink_observability_reconciliation_reset.sh"
)
PROCUREMENT_VENDOR_MASTER_CONTROLS_RESET_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_procurement_vendor_master_controls_reset.sh"
)
RERENT_UNIT_STATUS_LOG_RESET_SCRIPT_PATH = (
    REPO_ROOT / "supabase" / "tests" / "run_rerent_routing_init_status_log_reset.sh"
)


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def _run_reset_script(
    tmp_path: Path,
    script_path: Path,
    *,
    transient_failures: int,
) -> tuple[subprocess.CompletedProcess[str], list[dict[str, Any]]]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    log_path = tmp_path / "supabase-log.jsonl"

    _write_executable(
        fake_bin / "supabase",
        """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
log_path = Path(os.environ["FAKE_SUPABASE_LOG"])
state_path = Path(os.environ["FAKE_SUPABASE_STATE"])
state = json.loads(state_path.read_text()) if state_path.exists() else {"reset_attempts": 0}

with log_path.open("a", encoding="utf-8") as fh:
    fh.write(json.dumps({"args": args}) + "\\n")

if args[-1:] == ["--help"] or args[-2:] == ["reset", "--help"]:
    print("--yes")
    print("--config")
    raise SystemExit(0)

if args and args[0] == "start":
    print("Started supabase local development setup.")
    raise SystemExit(0)

if args[:2] == ["db", "reset"]:
    state["reset_attempts"] += 1
    state_path.write_text(json.dumps(state))
    if state["reset_attempts"] <= int(os.environ["FAKE_TRANSIENT_FAILURES"]):
        print("Error status 502: An invalid response was received from the upstream server", file=sys.stderr)
        raise SystemExit(1)
    print("Reset complete")
    raise SystemExit(0)

if args and args[0] == "stop":
    raise SystemExit(0)

raise SystemExit(1)
""",
    )
    _write_executable(
        fake_bin / "psql",
        """#!/usr/bin/env python3
raise SystemExit(0)
""",
    )
    # No-op sleep so retry backoff (sleep $((attempts * 5))) in the lib does not
    # burn real wall-clock time in these unit-level harness tests.
    _write_executable(fake_bin / "sleep", "#!/usr/bin/env bash\n")

    completed = subprocess.run(
        ["bash", str(script_path)],
        text=True,
        capture_output=True,
        cwd=REPO_ROOT,
        timeout=30.0,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "FAKE_SUPABASE_LOG": str(log_path),
            "FAKE_SUPABASE_STATE": str(tmp_path / "supabase-state.json"),
            "FAKE_TRANSIENT_FAILURES": str(transient_failures),
        },
    )

    events = [json.loads(line) for line in log_path.read_text().splitlines()]
    return completed, events


def test_demo_baseline_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, DEMO_SCRIPT_PATH, transient_failures=2)

    assert completed.returncode == 0, completed.stderr
    assert "Demo baseline seed reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_demo_baseline_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, DEMO_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Demo baseline seed reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_rental_foundation_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, RENTAL_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Rental master data and live yard activity projection reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_rental_order_contract_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, RENTAL_ORDER_CONTRACT_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Rental order/contract reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_rerent_routing_init_status_log_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, RERENT_UNIT_STATUS_LOG_RESET_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "rerent_unit_status_log reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_driver_dispatch_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, DRIVER_DISPATCH_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Driver dispatch execution reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_driver_runsheet_contact_fields_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, DRIVER_RUNSHEET_CONTACT_FIELDS_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "driver_runsheet_contact_fields reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_dispatch_live_ops_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, DISPATCH_LIVE_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Dispatch live ops reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_logistics_compliance_surface_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, LOGISTICS_COMPLIANCE_SCRIPT_PATH, transient_failures=2)

    assert completed.returncode == 0, completed.stderr
    assert "Logistics compliance surface reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_logistics_compliance_surface_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, LOGISTICS_COMPLIANCE_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "Logistics compliance surface reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_mulesoft_delivery_observability_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, MULESOFT_DELIVERY_OBS_SCRIPT_PATH, transient_failures=2)

    assert completed.returncode == 0, completed.stderr
    assert "MuleSoft delivery observability reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_mulesoft_delivery_observability_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, MULESOFT_DELIVERY_OBS_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "MuleSoft delivery observability reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_integration_config_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, INTEGRATION_CONFIG_SCRIPT_PATH, transient_failures=2)

    assert completed.returncode == 0, completed.stderr
    assert "integration_config reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_smartequip_delivery_observability_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, SMARTEQUIP_DELIVERY_OBS_RESET_SCRIPT_PATH, transient_failures=2)

    assert completed.returncode == 0, completed.stderr
    assert "SmartEquip delivery observability reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_smartequip_delivery_observability_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, SMARTEQUIP_DELIVERY_OBS_RESET_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "SmartEquip delivery observability reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_descartes_sync_controls_reset_script_retries_transient_502_until_success(tmp_path: Path) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        DESCARTES_SYNC_CONTROLS_RESET_SCRIPT_PATH,
        transient_failures=2,
    )

    assert completed.returncode == 0, completed.stderr
    assert "Descartes sync controls reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_integration_config_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(tmp_path, INTEGRATION_CONFIG_SCRIPT_PATH, transient_failures=5)

    assert completed.returncode == 0, completed.stderr
    assert "integration_config reset checks passed" in completed.stdout

    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_descartes_sync_controls_reset_script_tolerates_five_transient_502s(tmp_path: Path) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        DESCARTES_SYNC_CONTROLS_RESET_SCRIPT_PATH,
        transient_failures=5,
    )
    assert completed.returncode == 0, completed.stderr
    assert "Descartes sync controls reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_billtrust_observability_reconciliation_reset_script_retries_transient_502_until_success(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        BILLTRUST_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH,
        transient_failures=2,
    )

    assert completed.returncode == 0, completed.stderr
    assert "Billtrust observability and reconciliation reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_billtrust_observability_reconciliation_reset_script_tolerates_five_transient_502s(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        BILLTRUST_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH,
        transient_failures=5,
    )

    assert completed.returncode == 0, completed.stderr
    assert "Billtrust observability and reconciliation reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_inspection_checklist_templates_reset_script_retries_transient_502_until_success(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        INSPECTION_CHECKLIST_TEMPLATES_RESET_SCRIPT_PATH,
        transient_failures=2,
    )

    assert completed.returncode == 0, completed.stderr
    assert "inspection_checklist_templates reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_visionlink_observability_reconciliation_reset_script_retries_transient_502_until_success(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        VISIONLINK_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH,
        transient_failures=2,
    )

    assert completed.returncode == 0, completed.stderr
    assert "VisionLink observability and reconciliation reset checks passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_visionlink_observability_reconciliation_reset_script_tolerates_five_transient_502s(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        VISIONLINK_OBSERVABILITY_RECONCILIATION_RESET_SCRIPT_PATH,
        transient_failures=5,
    )

    assert completed.returncode == 0, completed.stderr
    assert "VisionLink observability and reconciliation reset checks passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6


def test_procurement_vendor_master_controls_reset_script_retries_transient_502_until_success(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        PROCUREMENT_VENDOR_MASTER_CONTROLS_RESET_SCRIPT_PATH,
        transient_failures=2,
    )

    assert completed.returncode == 0, completed.stderr
    assert "procurement_vendor_master_controls reset-path validation passed" in completed.stdout
    assert "Retrying (attempt 1 of 5)" in completed.stderr
    assert "Retrying (attempt 2 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 3


def test_procurement_vendor_master_controls_reset_script_tolerates_five_transient_502s(
    tmp_path: Path,
) -> None:
    completed, events = _run_reset_script(
        tmp_path,
        PROCUREMENT_VENDOR_MASTER_CONTROLS_RESET_SCRIPT_PATH,
        transient_failures=5,
    )

    assert completed.returncode == 0, completed.stderr
    assert "procurement_vendor_master_controls reset-path validation passed" in completed.stdout
    assert "Retrying (attempt 5 of 5)" in completed.stderr

    reset_calls = [event for event in events if event["args"][:2] == ["db", "reset"] and "--help" not in event["args"]]
    assert len(reset_calls) == 6
