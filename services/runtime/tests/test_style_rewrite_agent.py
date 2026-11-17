"""Strict response, locale, and redaction tests for the Style provider adapter."""

import json

import pytest

from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfile
from services.runtime.stt_runtime.schemas.agent_memory import ApprovedAgentMemoryV1
from services.runtime.stt_runtime.schemas.style_rewrite import StyleRewriteContextPackageV1
from services.runtime.stt_runtime.style_system.rewrite_agent import (
    StyleRewriteAgentError,
    StyleRewriteAgentResponse,
    StyleRewriteAgentService,
)
from services.runtime.stt_runtime.impact.resolution_agent import ImpactResolutionAgentError


class _Transport:
    """Capture the exact outbound boundary and return controlled provider JSON."""

    def __init__(self, response: dict | None = None, error: Exception | None = None) -> None:
        self.response = response or {}
        self.error = error
        self.calls: list[dict] = []

    def request_json(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.error:
            raise self.error
        return self.response


def test_agent_sends_only_context_and_returns_strict_recommendation() -> None:
    response = StyleRewriteAgentResponse(
        rewritten_text="The bell struck. Mara ran.",
        explanation="Shorter beats increase urgency.",
        applied_traits=("short beats",),
        factual_risks=(),
    )
    transport = _Transport({"output_text": response.model_dump_json()})
    profile = CanonProviderProfile(
        profile_id="provider-one", label="Provider", provider="openai", api_key="private-key"
    )

    result = StyleRewriteAgentService(transport).run(profile, "model-one", _context())

    assert result == response
    serialized = json.dumps(transport.calls[0]["body"])
    assert "The bell rang. Mara moved." in serialized
    assert "project_path" not in serialized
    assert "project-one" not in serialized
    assert "node-one" not in serialized
    assert "history_revision" not in serialized
    assert "document_checksum" not in serialized
    assert "source_text_checksum" not in serialized
    assert profile.api_key not in serialized
    assert transport.calls[0]["body"]["store"] is False
    provider_context = json.loads(
        transport.calls[0]["body"]["input"].split("\n", maxsplit=1)[1]
    )
    assert provider_context["approved_memory"]["entries"][0]["instruction"] == (
        "Keep harbor terminology exact."
    )
    assert "reviewed author guidance" in transport.calls[0]["body"]["instructions"]


@pytest.mark.parametrize("payload", ["not-json", '{"response_version":1,"rewritten_text":"x","explanation":"x","extra":1}'])
def test_agent_rejects_malformed_or_extended_output(payload: str) -> None:
    with pytest.raises(StyleRewriteAgentError) as raised:
        StyleRewriteAgentService(_Transport({"output_text": payload})).run(
            CanonProviderProfile(
                profile_id="provider-one", label="Provider", provider="openai", api_key="private-key"
            ),
            "model-one",
            _context(),
        )
    assert raised.value.code == "style_rewrite_response_invalid"


@pytest.mark.parametrize(("upstream", "expected"), [
    ("impact_resolution_provider_timeout", "style_rewrite_provider_timeout"),
    ("impact_resolution_model_incompatible", "style_rewrite_model_incompatible"),
])
def test_agent_maps_provider_failures_without_leaking_remote_details(
    upstream: str,
    expected: str,
) -> None:
    transport = _Transport(error=ImpactResolutionAgentError(upstream, remote="secret prose"))
    with pytest.raises(StyleRewriteAgentError) as raised:
        StyleRewriteAgentService(transport).run(
            CanonProviderProfile(
                profile_id="provider-one", label="Provider", provider="openai", api_key="private-key"
            ),
            "model-one",
            _context(),
        )
    assert raised.value.code == expected
    assert raised.value.parameters == {}
    assert "secret prose" not in str(raised.value)


def test_agent_rejects_unsupported_locale_before_transport() -> None:
    transport = _Transport()
    context = _context().model_copy(update={"content_locale": "es"})
    with pytest.raises(StyleRewriteAgentError) as raised:
        StyleRewriteAgentService(transport).run(
            CanonProviderProfile(
                profile_id="provider-one", label="Provider", provider="openai", api_key="private-key"
            ),
            "model-one",
            context,
        )
    assert raised.value.code == "style_rewrite_locale_unsupported"
    assert transport.calls == []


@pytest.mark.parametrize(
    ("locale", "instruction"),
    [
        ("en", "Write all generated author-facing prose in English."),
        ("ru", "Пиши весь сгенерированный для автора текст на русском языке."),
    ],
)
def test_agent_uses_project_content_locale_for_provider_output(
    locale: str,
    instruction: str,
) -> None:
    """Provider prose follows project content without receiving UI preferences."""

    response = StyleRewriteAgentResponse(
        rewritten_text="Сигнал изменился." if locale == "ru" else "The signal changed.",
        explanation="Ритм уточнён." if locale == "ru" else "The rhythm is tighter.",
    )
    transport = _Transport({"output_text": response.model_dump_json()})
    profile = CanonProviderProfile(
        profile_id="provider-one", label="Provider", provider="openai", api_key="private-key"
    )

    StyleRewriteAgentService(transport).run(
        profile,
        "model-one",
        _context().model_copy(update={"content_locale": locale}),
    )

    body = transport.calls[0]["body"]
    assert instruction in body["instructions"]
    assert f'"content_locale":"{locale}"' in body["input"]
    assert "ui_locale" not in json.dumps(body)


def _context() -> StyleRewriteContextPackageV1:
    return StyleRewriteContextPackageV1(
        project_id="project-one",
        content_locale="en",
        target={"kind": "node_text", "node_id": "node-one"},
        source_text="The bell rang. Mara moved.",
        source_text_checksum="a" * 64,
        document_checksum="b" * 64,
        history_revision=2,
        target_title="Arrival",
        style_profile_id="style-one",
        style_profile_name="Urgent",
        style_guidance="Use short beats.",
        style_traits=("urgent",),
        approved_memory=ApprovedAgentMemoryV1(
            agent_id="style_rewriter",
            content_locale="en",
            entries=(
                {
                    "memory_id": "memory-one",
                    "title": "Harbor terms",
                    "instruction": "Keep harbor terminology exact.",
                    "scope": {"scope_version": 1, "kind": "project"},
                },
            ),
        ),
        additional_instructions="",
    )
