from __future__ import annotations

import pytest

from temporal.src.agents.i18n import (
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    language_directive,
    resolve_locale,
    with_language_directive,
)


@pytest.mark.parametrize("locale", [None, "", "   ", "fr-FR", "pt-br", "en"])
def test_resolve_locale_falls_back_to_default_for_empty_or_unknown(locale: str | None) -> None:
    assert resolve_locale(locale) == DEFAULT_LOCALE


@pytest.mark.parametrize("locale", sorted(SUPPORTED_LOCALES))
def test_resolve_locale_passes_through_supported_locales(locale: str) -> None:
    assert resolve_locale(locale) == locale


def test_language_directive_returns_portuguese_instruction_for_default_locale() -> None:
    directive = language_directive("pt-BR")

    assert "Responda em português do Brasil" in directive
    assert "pt-BR" in directive
    assert "Reply in English" not in directive


def test_language_directive_returns_english_instruction_for_en_us() -> None:
    directive = language_directive("en-US")

    assert "Reply in English" in directive
    assert "en-US" in directive
    assert "Responda em português" not in directive


def test_with_language_directive_appends_resolved_language_instruction() -> None:
    prompt = "Use business evidence before answering."

    with_directive = with_language_directive(prompt, "en-US")

    assert with_directive.startswith(prompt)
    assert "Language directive" in with_directive
    assert "Reply in English" in with_directive


def test_with_language_directive_returns_only_directive_when_prompt_is_empty() -> None:
    assert with_language_directive("", "unknown") == language_directive(DEFAULT_LOCALE)
