from __future__ import annotations

DEFAULT_LOCALE = "pt-BR"
SUPPORTED_LOCALES = {"pt-BR", "en-US"}

_LANGUAGE_DIRECTIVES = {
    "pt-BR": (
        "Responda em português do Brasil (pt-BR). Localize apenas texto natural "
        "para usuários, mantendo códigos, IDs, chaves e valores enum exatamente como recebidos."
    ),
    "en-US": (
        "Reply in English (en-US). Localize only user-facing natural language, "
        "while keeping codes, IDs, keys, and enum values exactly as received."
    ),
}


def resolve_locale(locale: str | None) -> str:
    value = str(locale or "").strip()
    return value if value in SUPPORTED_LOCALES else DEFAULT_LOCALE


def language_directive(locale: str | None) -> str:
    return _LANGUAGE_DIRECTIVES[resolve_locale(locale)]


def with_language_directive(system_prompt: str, locale: str | None = None) -> str:
    base = str(system_prompt or "").rstrip()
    directive = language_directive(locale)
    return f"{base}\n\nDiretiva de idioma / Language directive: {directive}" if base else directive


__all__ = [
    "DEFAULT_LOCALE",
    "SUPPORTED_LOCALES",
    "language_directive",
    "resolve_locale",
    "with_language_directive",
]
