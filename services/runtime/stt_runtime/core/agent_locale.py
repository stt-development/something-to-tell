"""Shared project-content language boundary for every remote agent."""

from typing import cast

from ..project_format.manifest import ProjectLocale, SUPPORTED_PROJECT_LOCALES

AgentContentLocale = ProjectLocale
DEFAULT_AGENT_CONTENT_LOCALE: AgentContentLocale = "en"


def resolve_agent_content_locale(value: object) -> AgentContentLocale:
    """Normalize legacy input without delegating language choice to a provider."""

    if isinstance(value, str) and value in SUPPORTED_PROJECT_LOCALES:
        return cast(AgentContentLocale, value)
    return DEFAULT_AGENT_CONTENT_LOCALE


def agent_response_language_instruction(value: object) -> str:
    """Constrain generated prose while preserving all authored and wire values."""

    locale = resolve_agent_content_locale(value)
    if locale == "ru":
        return (
            "Пиши весь сгенерированный для автора текст на русском языке. "
            "Не переводи и не изменяй идентификаторы, enum-значения, пути полей, "
            "имена из авторских данных, значения evidence и данные ProjectPatch."
        )
    return (
        "Write all generated author-facing prose in English. "
        "Do not translate or alter identifiers, enum values, field paths, authored "
        "names, evidence values, or ProjectPatch data."
    )
