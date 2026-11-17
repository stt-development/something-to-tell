"""Shared language-contract coverage for current and future remote agents."""

import pytest

from services.runtime.stt_runtime.core.agent_locale import (
    agent_response_language_instruction,
    resolve_agent_content_locale,
)


@pytest.mark.parametrize(("value", "expected"), [
    ("en", "en"),
    ("ru", "ru"),
    ("es", "en"),
    (None, "en"),
])
def test_agent_content_locale_has_one_deterministic_fallback(
    value: object,
    expected: str,
) -> None:
    assert resolve_agent_content_locale(value) == expected


@pytest.mark.parametrize(("locale", "language", "preserved"), [
    ("en", "in English", "Do not translate or alter identifiers"),
    ("ru", "на русском языке", "Не переводи и не изменяй идентификаторы"),
])
def test_agent_language_instruction_limits_translation_to_generated_prose(
    locale: str,
    language: str,
    preserved: str,
) -> None:
    instruction = agent_response_language_instruction(locale)

    assert language in instruction
    assert preserved in instruction
    assert "ProjectPatch" in instruction
