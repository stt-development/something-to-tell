"""Provider adapter tests prove structured parsing and payload redaction."""

import json

import pytest

from services.runtime.stt_runtime.agent_memory.candidate_agent import (
    AgentMemoryCandidateAgentError,
    AgentMemoryCandidateAgentService,
)
from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfile
from services.runtime.stt_runtime.schemas.agent_memory_candidate import (
    AgentMemoryCandidateContextV1,
)


class _Transport:
    """Capture outbound JSON while returning one provider-shaped response."""

    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def request_json(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.response


def _context() -> AgentMemoryCandidateContextV1:
    return AgentMemoryCandidateContextV1(
        project_name="Project Aurora",
        target_kind="Scene",
        target_title="Glass Harbor",
        target_text="Rain crossed the harbor lights.",
        omitted_target_characters=0,
        guidance_request="Remember the restrained maritime tone.",
        content_locale="en",
        scope={"scope_version": 1, "kind": "scene", "scene_node_id": "scene-harbor"},
    )


def _profile(provider: str) -> CanonProviderProfile:
    return CanonProviderProfile.model_validate({
        "profile_id": "provider-test",
        "label": "Test provider",
        "provider": provider,
        "api_key": "private-provider-key",
    })


@pytest.mark.parametrize(
    ("provider", "response"),
    [
        (
            "openai",
            {"output_text": json.dumps({
                "response_version": 1,
                "title": "Harbor tone",
                "instruction": "Keep maritime images restrained.",
                "rationale": None,
            })},
        ),
        (
            "google_gemini",
            {"choices": [{"message": {"content": json.dumps({
                "response_version": 1,
                "title": "Harbor tone",
                "instruction": "Keep maritime images restrained.",
                "rationale": None,
            })}}]},
        ),
        (
            "anthropic",
            {"content": [{"type": "text", "text": json.dumps({
                "response_version": 1,
                "title": "Harbor tone",
                "instruction": "Keep maritime images restrained.",
                "rationale": None,
            })}]},
        ),
    ],
)
def test_parses_provider_shapes_without_retaining_raw_payload_or_key(
    provider: str,
    response: dict[str, object],
) -> None:
    transport = _Transport(response)
    service = AgentMemoryCandidateAgentService(transport)

    result = service.run(_profile(provider), "candidate-model", _context())

    assert result.title == "Harbor tone"
    call = transport.calls[0]
    assert call["api_key"] == "private-provider-key"
    assert "private-provider-key" not in json.dumps(call["body"])
    assert "response" not in result.model_dump()
    if provider == "openai":
        assert call["body"]["store"] is False


@pytest.mark.parametrize(
    "response",
    [
        {"output_text": "not-json"},
        {"output_text": json.dumps({"response_version": 1, "title": "Missing"})},
        {"output_text": json.dumps({
            "response_version": 1,
            "title": "Extra",
            "instruction": "Keep this.",
            "rationale": None,
            "provider_session_id": "forbidden",
        })},
    ],
)
def test_rejects_malformed_provider_output_with_one_redacted_error(
    response: dict[str, object],
) -> None:
    service = AgentMemoryCandidateAgentService(_Transport(response))

    with pytest.raises(AgentMemoryCandidateAgentError) as raised:
        service.run(_profile("openai"), "candidate-model", _context())

    assert raised.value.code == "agent_memory_candidate_response_invalid"
    assert "not-json" not in str(raised.value)
