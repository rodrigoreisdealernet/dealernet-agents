from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / ".github" / "scripts" / "build-images-metadata.sh"
TEST_SHA = "0123456789abcdef0123456789abcdef01234567"
SKIP_MESSAGE = "Image push skipped: set vars.ACR_LOGIN_SERVER and configure ACR_USERNAME/ACR_PASSWORD secrets to enable registry push."


def _run_script(mode: str, *, env: dict[str, str], use_github_output: bool = True) -> tuple[subprocess.CompletedProcess[str], str]:
    full_env = {**os.environ, **env}

    if not use_github_output:
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), mode],
            text=True,
            capture_output=True,
            env=full_env,
            check=True,
            cwd=REPO_ROOT,
            timeout=30.0,
        )
        return result, result.stdout

    with tempfile.TemporaryDirectory(prefix=f"build-images-{mode}-") as tmp_dir:
        output_file = Path(tmp_dir) / "github-output.txt"
        full_env["GITHUB_OUTPUT"] = str(output_file)
        result = subprocess.run(
            ["bash", str(SCRIPT_PATH), mode],
            text=True,
            capture_output=True,
            env=full_env,
            check=True,
            cwd=REPO_ROOT,
            timeout=30.0,
        )
        return result, output_file.read_text()


def _parse_simple_outputs(raw_output: str) -> dict[str, str]:
    outputs: dict[str, str] = {}
    for line in raw_output.splitlines():
        if "=" in line and not line.startswith("tags<<"):
            key, value = line.split("=", 1)
            outputs[key] = value
    return outputs


def _parse_tags(raw_output: str) -> list[str]:
    lines = raw_output.splitlines()
    tags_start = lines.index("tags<<EOF") + 1
    tags_end = lines.index("EOF", tags_start)
    return lines[tags_start:tags_end]


@pytest.mark.parametrize("image_name", ["frontend", "temporal-worker"])
def test_pull_request_path_is_build_only_and_emits_local_immutable_tags(image_name: str) -> None:
    _, gate_output = _run_script(
        "push-gate",
        env={
            "IS_MAIN_PUSH": "false",
            "REGISTRY": "",
            "REGISTRY_USERNAME": "",
            "REGISTRY_PASSWORD": "",
        },
    )
    parsed_gate = _parse_simple_outputs(gate_output)
    assert parsed_gate == {"is_main_push": "false", "enabled": "false"}

    _, tags_output = _run_script(
        "image-tags",
        env={
            "GITHUB_SHA": TEST_SHA,
            "IMAGE_NAME": image_name,
            "REGISTRY": "",
        },
    )
    tags = _parse_tags(tags_output)
    assert tags == [
        f"local/{image_name}:{TEST_SHA}",
        f"local/{image_name}:{TEST_SHA[:12]}",
    ]
    assert all(not tag.endswith(":latest") for tag in tags)


@pytest.mark.parametrize("image_name", ["frontend", "temporal-worker"])
def test_main_branch_with_registry_config_enables_push_and_uses_registry_tags(image_name: str) -> None:
    _, gate_output = _run_script(
        "push-gate",
        env={
            "IS_MAIN_PUSH": "true",
            "REGISTRY": "example.azurecr.io",
            "REGISTRY_USERNAME": "user",
            "REGISTRY_PASSWORD": "pass",
        },
    )
    parsed_gate = _parse_simple_outputs(gate_output)
    assert parsed_gate == {"is_main_push": "true", "enabled": "true"}

    _, tags_output = _run_script(
        "image-tags",
        env={
            "GITHUB_SHA": TEST_SHA,
            "IMAGE_NAME": image_name,
            "REGISTRY": "example.azurecr.io",
        },
    )
    tags = _parse_tags(tags_output)
    assert tags == [
        f"example.azurecr.io/{image_name}:{TEST_SHA}",
        f"example.azurecr.io/{image_name}:{TEST_SHA[:12]}",
    ]
    assert all(not tag.endswith(":latest") for tag in tags)


@pytest.mark.parametrize("missing_key", ["REGISTRY", "REGISTRY_USERNAME", "REGISTRY_PASSWORD"])
def test_main_branch_missing_registry_config_disables_push_and_logs_single_line_skip(missing_key: str) -> None:
    env = {
        "IS_MAIN_PUSH": "true",
        "REGISTRY": "example.azurecr.io",
        "REGISTRY_USERNAME": "user",
        "REGISTRY_PASSWORD": "pass",
    }
    env[missing_key] = ""

    _, gate_output = _run_script("push-gate", env=env)
    parsed_gate = _parse_simple_outputs(gate_output)
    assert parsed_gate == {"is_main_push": "true", "enabled": "false"}

    _, skip_output = _run_script("skip-message", env=env, use_github_output=False)
    skip_lines = skip_output.strip().splitlines()
    assert skip_lines == [SKIP_MESSAGE]
