"""Pytest configuration for the Temporal worker test suite.

The suite mixes fast in-process unit tests with a set of heavy Supabase
reset/smoke validations. Each heavy test spins up a full ``supabase db reset``
(~2 minutes apiece); there are ~25 of them, so they dominate the wall-clock of
the otherwise-fast ``Temporal worker tests`` CI job and serialize to ~45+ min.

Those validations only exercise the *database surface*. When a change does not
touch ``supabase/`` or ``temporal/`` (e.g. a frontend-only PR), there is nothing
for them to catch, so PR CI sets ``SKIP_SUPABASE_RESET_VALIDATION=1`` to deselect
them and keep the required check fast. Full coverage still runs on any PR that
touches the DB surface and on every push to ``main`` (see
``.github/workflows/pr-validation.yml``).

The two ``*_reset_validation`` *library* unit tests
(``test_reset_validation_detects_duplicate_migrations`` /
``..._lib_preserves_unique_migration_versions``) are pure-Python and cheap; the
suffix match below intentionally excludes them — they end in ``migrations`` /
``versions``, not ``_reset_validation``/``_smoke_validation``.
"""

from __future__ import annotations

import os

import pytest

# Heavy tests are named with these suffixes and each performs a real
# `supabase db reset`. Suffix (not substring) matching keeps the cheap
# library unit tests in the run.
_HEAVY_SUFFIXES = ("_reset_validation", "_smoke_validation")


def pytest_collection_modifyitems(items) -> None:  # noqa: ANN001
    if os.environ.get("SKIP_SUPABASE_RESET_VALIDATION") != "1":
        return

    skip_marker = pytest.mark.skip(
        reason=(
            "Supabase reset/smoke validation skipped: this change does not touch "
            "supabase/ or temporal/ (SKIP_SUPABASE_RESET_VALIDATION=1)."
        )
    )
    for item in items:
        # `item.originalname` is the bare function name without any
        # parametrization suffix; fall back to `item.name` if unavailable.
        name = getattr(item, "originalname", None) or item.name
        if name.endswith(_HEAVY_SUFFIXES):
            item.add_marker(skip_marker)
