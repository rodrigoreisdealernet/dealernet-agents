"""Behavioral tests for the pytest_collection_modifyitems hook in conftest.py.

Proves that:
- When SKIP_SUPABASE_RESET_VALIDATION=1, every item whose name ends with
  ``_reset_validation`` or ``_smoke_validation`` is marked skip.
- When SKIP_SUPABASE_RESET_VALIDATION=1, items whose names end with
  ``_migrations`` or ``_versions`` (the two cheap library tests) are NOT skipped.
- When SKIP_SUPABASE_RESET_VALIDATION is unset or is not "1", the hook is inert
  and no items are skipped.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from unittest.mock import patch

import pytest

# Load pytest_collection_modifyitems from conftest.py by file path so that
# pytest's own conftest plugin machinery does not interfere.
_CONFTEST_PATH = Path(__file__).parent / "conftest.py"
_spec = importlib.util.spec_from_file_location("_conftest_module", _CONFTEST_PATH)
_conftest_module = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_conftest_module)  # type: ignore[union-attr]
pytest_collection_modifyitems = _conftest_module.pytest_collection_modifyitems


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeItem:
    """Minimal stand-in for a pytest.Item that records add_marker calls."""

    def __init__(self, name: str) -> None:
        self.originalname: str = name
        self.name: str = name
        self._markers: list[pytest.Mark] = []

    def add_marker(self, marker: pytest.Mark) -> None:  # noqa: ANN001
        self._markers.append(marker)

    @property
    def was_skipped(self) -> bool:
        return len(self._markers) > 0


def _run_hook(items: list[_FakeItem], *, skip_flag: str | None) -> None:
    """Call pytest_collection_modifyitems with the env var patched as specified."""
    env_patch: dict[str, str] = {}
    if skip_flag is not None:
        env_patch["SKIP_SUPABASE_RESET_VALIDATION"] = skip_flag
    with patch.dict(os.environ, env_patch, clear=True):
        pytest_collection_modifyitems(items)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Heavy-test names that must be skipped when the flag is set
# ---------------------------------------------------------------------------

_HEAVY_NAMES = [
    "test_rental_master_data_foundation_reset_validation",
    "test_demo_baseline_seed_reset_validation",
    "test_crm_customer_profile_reset_validation",
    "test_portal_catalog_requisition_reset_validation",
    "test_quote_fee_engine_reset_validation",
    "test_fleet_availability_calendar_smoke_validation",
    "test_coupa_observability_reconciliation_smoke_validation",
    "test_live_yard_activity_projection_smoke_validation",
]

# ---------------------------------------------------------------------------
# Cheap library-test names that must NOT be skipped
# ---------------------------------------------------------------------------

_CHEAP_NAMES = [
    "test_reset_validation_detects_duplicate_migrations",
    "test_reset_validation_lib_preserves_unique_migration_versions",
]


# ---------------------------------------------------------------------------
# Tests: SKIP_SUPABASE_RESET_VALIDATION=1
# ---------------------------------------------------------------------------

def test_hook_skips_reset_validation_items_when_flag_set() -> None:
    """All *_reset_validation tests are marked skip when the env var is "1"."""
    heavy_items = [_FakeItem(n) for n in _HEAVY_NAMES if n.endswith("_reset_validation")]
    _run_hook(heavy_items, skip_flag="1")
    for item in heavy_items:
        assert item.was_skipped, f"{item.name!r} should have been skipped"


def test_hook_skips_smoke_validation_items_when_flag_set() -> None:
    """All *_smoke_validation tests are marked skip when the env var is "1"."""
    smoke_items = [_FakeItem(n) for n in _HEAVY_NAMES if n.endswith("_smoke_validation")]
    _run_hook(smoke_items, skip_flag="1")
    for item in smoke_items:
        assert item.was_skipped, f"{item.name!r} should have been skipped"


def test_hook_leaves_cheap_library_tests_when_flag_set() -> None:
    """The two pure-Python library tests (_migrations / _versions suffixes) are NOT
    skipped even when SKIP_SUPABASE_RESET_VALIDATION=1, because they end with neither
    '_reset_validation' nor '_smoke_validation'."""
    cheap_items = [_FakeItem(n) for n in _CHEAP_NAMES]
    _run_hook(cheap_items, skip_flag="1")
    for item in cheap_items:
        assert not item.was_skipped, (
            f"{item.name!r} is a cheap library test and must NOT be skipped"
        )


def test_hook_skips_only_heavy_not_cheap_in_mixed_collection() -> None:
    """With a mixed collection, only the heavy tests are skipped."""
    all_items = [_FakeItem(n) for n in _HEAVY_NAMES + _CHEAP_NAMES]
    _run_hook(all_items, skip_flag="1")

    for item in all_items:
        if item.name.endswith(("_reset_validation", "_smoke_validation")):
            assert item.was_skipped, f"{item.name!r} should be skipped"
        else:
            assert not item.was_skipped, f"{item.name!r} should NOT be skipped"


# ---------------------------------------------------------------------------
# Tests: hook inert when flag is unset or wrong value
# ---------------------------------------------------------------------------

def test_hook_is_inert_when_flag_unset() -> None:
    """When SKIP_SUPABASE_RESET_VALIDATION is not set, no items are marked skip."""
    all_items = [_FakeItem(n) for n in _HEAVY_NAMES + _CHEAP_NAMES]
    _run_hook(all_items, skip_flag=None)
    for item in all_items:
        assert not item.was_skipped, (
            f"{item.name!r} should not be skipped when env var is absent"
        )


def test_hook_is_inert_when_flag_is_zero() -> None:
    """When SKIP_SUPABASE_RESET_VALIDATION=0, no items are marked skip."""
    all_items = [_FakeItem(n) for n in _HEAVY_NAMES + _CHEAP_NAMES]
    _run_hook(all_items, skip_flag="0")
    for item in all_items:
        assert not item.was_skipped, (
            f"{item.name!r} should not be skipped when env var is '0'"
        )


def test_hook_is_inert_when_flag_is_empty_string() -> None:
    """When SKIP_SUPABASE_RESET_VALIDATION='', no items are marked skip."""
    all_items = [_FakeItem(n) for n in _HEAVY_NAMES]
    _run_hook(all_items, skip_flag="")
    for item in all_items:
        assert not item.was_skipped, (
            f"{item.name!r} should not be skipped when env var is empty"
        )


# ---------------------------------------------------------------------------
# Tests: suffix matching (not substring)
# ---------------------------------------------------------------------------

def test_hook_uses_suffix_not_substring_match() -> None:
    """A test whose name contains '_reset_validation' in the middle but does NOT
    end with that suffix must not be skipped (suffix, not substring match)."""
    # e.g. a hypothetical test that *mentions* reset_validation in its name but
    # ends with something else:
    edge_case = _FakeItem("test_reset_validation_detects_duplicate_migrations")
    _run_hook([edge_case], skip_flag="1")
    assert not edge_case.was_skipped, (
        "test_reset_validation_detects_duplicate_migrations ends with '_migrations', "
        "not '_reset_validation', so it must not be skipped"
    )
