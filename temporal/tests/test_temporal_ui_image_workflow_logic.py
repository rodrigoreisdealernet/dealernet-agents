from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / ".github" / "scripts" / "temporal-ui-image.sh"


def _run_script(mode: str, *, env: dict[str, str], use_github_output: bool = True) -> tuple[subprocess.CompletedProcess[str], str]:
    full_env = {**os.environ, **env}

    if not use_github_output:
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), mode],
            text=True,
            capture_output=True,
            env=full_env,
            cwd=REPO_ROOT,
            check=False,
            timeout=30.0,
        )
        return result, result.stdout

    with tempfile.TemporaryDirectory(prefix=f"temporal-ui-image-{mode}-") as tmp_dir:
        output_file = Path(tmp_dir) / "github-output.txt"
        full_env["GITHUB_OUTPUT"] = str(output_file)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), mode],
            text=True,
            capture_output=True,
            env=full_env,
            cwd=REPO_ROOT,
            check=False,
            timeout=30.0,
        )
        output_text = output_file.read_text() if output_file.exists() else ""
        return result, output_text


def _parse_outputs(raw_output: str) -> dict[str, str]:
    outputs: dict[str, str] = {}
    for line in raw_output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            outputs[key] = value
    return outputs


def test_resolve_outputs_temporal_ui_source_and_acr_target_refs() -> None:
    result, raw_output = _run_script("resolve", env={"REGISTRY": "example.azurecr.io"})

    assert result.returncode == 0, result.stderr
    assert _parse_outputs(raw_output) == {
        "repository": "temporalio/ui",
        "tag": "2.31.2",
        "source_ref": "docker.io/temporalio/ui:2.31.2",
        "target_ref": "example.azurecr.io/temporalio/ui:2.31.2",
    }


@pytest.mark.parametrize("missing_key", ["REGISTRY", "REGISTRY_USERNAME", "REGISTRY_PASSWORD"])
def test_validate_requires_registry_credentials_before_remote_checks(missing_key: str) -> None:
    env = {
        "REGISTRY": "example.azurecr.io",
        "REGISTRY_USERNAME": "user",
        "REGISTRY_PASSWORD": "pass",
    }
    env[missing_key] = ""

    result, _ = _run_script("validate", env=env, use_github_output=False)

    assert result.returncode == 1
    assert f"validate mode: {missing_key} is required" in result.stderr
