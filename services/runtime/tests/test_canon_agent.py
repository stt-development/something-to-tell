import json
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError

import pytest

from services.runtime.stt_runtime.canon import agent as agent_module
from services.runtime.stt_runtime.canon.agent import (
    CanonAgentError,
    CanonAgentService,
    build_evidence_only_payload,
    enrich_candidates,
    resolve_canon_memory,
    UrlLibCanonAgentTransport,
    validate_agent_response,
)
from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfile
from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfileRegistry
from services.runtime.stt_runtime.canon.coordinator import CanonRunCoordinator
from services.runtime.stt_runtime.canon.engine import CanonRuleEngine
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.canon_agent import (
    CanonAgentExplanation,
    CanonAgentPatchProposal,
    CanonAgentResponse,
)
from services.runtime.stt_runtime.schemas.canon_check import CanonFixSuggestionDecision, CanonRunStart
from services.runtime.stt_runtime.schemas.project_document import create_project_document

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


class _FakeTransport:
    """Captures provider requests while returning caller-controlled JSON."""

    def __init__(self, responses: list[dict]) -> None:
        self.responses = responses
        self.requests: list[dict] = []

    def request_json(
        self,
        method,
        url,
        *,
        api_key,
        provider,
        body=None,
        timeout_seconds=20.0,
    ):
        self.requests.append({
            "method": method,
            "url": url,
            "api_key": api_key,
            "provider": provider,
            "body": body,
            "timeout_seconds": timeout_seconds,
        })
        return self.responses.pop(0)


def _aurora_input(tmp_path: Path):
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(FIXTURE, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    try:
        return registry.capture_canon_input(opened.session.session_id)
    finally:
        registry.close(opened.session.session_id)


def test_model_catalog_uses_the_profile_provider_and_filters_non_text_models() -> None:
    transport = _FakeTransport([{
        "data": [
            {"id": "gpt-writing", "owned_by": "openai"},
            {"id": "text-embedding-3-small", "owned_by": "openai"},
            {"id": "gpt-writing", "owned_by": "openai"},
        ]
    }])
    profile = CanonProviderProfile(
        profile_id="provider-1",
        label="OpenAI",
        provider="openai",
        api_key="sk-private-test",
    )

    response = CanonAgentService(transport).list_models(profile)

    assert [model.id for model in response.models] == ["gpt-writing"]
    assert response.models[0].capabilities == (
        "text_generation",
        "structured_output",
    )
    assert transport.requests[0]["url"] == "https://api.openai.com/v1/models"
    assert "api_key" not in response.model_dump_json()


def test_anthropic_uses_native_model_and_structured_message_contract(tmp_path: Path) -> None:
    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)
    evidence = build_evidence_only_payload(check_input, candidates)
    selected = candidates[0]
    response = CanonAgentResponse(explanations=(CanonAgentExplanation(
        fingerprint=selected.fingerprint,
        explanation="Anthropic explanation",
    ),))
    transport = _FakeTransport([
        {
            "data": [
                {
                    "id": "claude-writer",
                    "display_name": "Claude Writer",
                    "capabilities": {"structured_outputs": {"supported": True}},
                },
                {
                    "id": "claude-legacy",
                    "capabilities": {"structured_outputs": {"supported": False}},
                },
            ]
        },
        {"content": [{"type": "text", "text": response.model_dump_json()}]},
    ])
    profile = CanonProviderProfile(
        profile_id="provider-anthropic",
        label="Claude",
        provider="anthropic",
        api_key="sk-ant-private-test",
    )
    agent = CanonAgentService(transport)

    models = agent.list_models(profile)
    result = agent.run(profile, "claude-writer", evidence, "en")

    assert [(model.id, model.label) for model in models.models] == [
        ("claude-writer", "Claude Writer")
    ]
    assert result == response
    model_request, message_request = transport.requests
    assert model_request["url"] == "https://api.anthropic.com/v1/models"
    assert model_request["provider"] == "anthropic"
    assert message_request["url"] == "https://api.anthropic.com/v1/messages"
    assert message_request["body"]["system"]
    assert message_request["body"]["max_tokens"] == 4096
    assert message_request["body"]["output_config"]["format"]["type"] == "json_schema"
    assert "response_format" not in message_request["body"]
    assert profile.api_key not in json.dumps(message_request["body"])


@pytest.mark.parametrize(("provider", "raw_response"), [
    ("openai", lambda payload: {"output_text": payload}),
    ("google_gemini", lambda payload: {"choices": [{"message": {"content": payload}}]}),
    ("anthropic", lambda payload: {"content": [{"type": "text", "text": payload}]}),
])
def test_agent_provider_success_substitution_contract(
    tmp_path: Path,
    provider: str,
    raw_response,
) -> None:
    """Every provider returns the same validated Canon response in one request."""

    check_input = _aurora_input(tmp_path)
    evidence = build_evidence_only_payload(
        check_input,
        CanonRuleEngine().evaluate(check_input),
        resolve_canon_memory(check_input, history_revision=0),
    )
    expected = CanonAgentResponse()
    transport = _FakeTransport([raw_response(expected.model_dump_json())])
    profile = CanonProviderProfile(
        profile_id=f"provider-{provider}",
        label=provider,
        provider=provider,
        api_key="private-provider-key",
    )

    actual = CanonAgentService(transport).run(profile, "writer-model", evidence, "en")

    assert actual == expected
    assert len(transport.requests) == 1
    assert transport.requests[0]["provider"] == provider
    assert transport.requests[0]["method"] == "POST"
    assert "memory-workflow-01-canon-en" in json.dumps(
        transport.requests[0]["body"]
    )
    assert "memory-workflow-03-impact-en" not in json.dumps(
        transport.requests[0]["body"]
    )


def test_agent_payload_removes_domain_error_prose_before_remote_transfer(
    tmp_path: Path,
) -> None:
    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)

    payload = build_evidence_only_payload(check_input, candidates)
    error_facts = [fact for fact in payload.facts if fact.level == "error"]

    assert error_facts
    assert all(
        evidence.excerpt is None
        for fact in error_facts
        for evidence in fact.evidence
    )
    assert all(
        evidence.message_key == "canon.evidence.integrity-fact"
        for fact in error_facts
        for evidence in fact.evidence
    )


def test_canon_memory_cannot_change_deterministic_issue_identity(tmp_path: Path) -> None:
    """Only the optional evidence payload receives Canon-specific reviewed prose."""

    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)
    approved_memory = resolve_canon_memory(check_input, history_revision=0)
    payload = build_evidence_only_payload(check_input, candidates, approved_memory)

    assert [item.memory_id for item in payload.approved_memory.entries] == [
        "memory-workflow-01-canon-en"
    ]
    assert [item.fingerprint for item in payload.issues] == [
        item.fingerprint for item in candidates
    ]
    assert [item.severity for item in payload.issues] == [
        item.severity for item in candidates
    ]


def test_anthropic_transport_uses_api_key_and_version_headers(monkeypatch) -> None:
    captured = {}

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"data": []}'

    def fake_urlopen(request, *, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setattr(agent_module, "urlopen", fake_urlopen)

    result = UrlLibCanonAgentTransport().request_json(
        "GET",
        "https://api.anthropic.com/v1/models",
        api_key="sk-ant-header-test",
        provider="anthropic",
    )

    request = captured["request"]
    assert result == {"data": []}
    assert request.get_header("X-api-key") == "sk-ant-header-test"
    assert request.get_header("Anthropic-version") == "2023-06-01"
    assert request.get_header("Authorization") is None


@pytest.mark.parametrize(("locale", "expected_language"), [
    ("en", "author-facing prose in English"),
    ("ru", "текст на русском языке"),
])
def test_openai_uses_project_content_locale_and_reads_validated_output(
    tmp_path: Path,
    locale: str,
    expected_language: str,
) -> None:
    """OpenAI JSON mode leaves arbitrary patch records to local validation."""

    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)
    evidence = build_evidence_only_payload(check_input, candidates)
    response = CanonAgentResponse(explanations=(CanonAgentExplanation(
        fingerprint=candidates[0].fingerprint,
        explanation="The authored evidence conflicts.",
    ),))
    transport = _FakeTransport([{
        "output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": response.model_dump_json()}],
        }],
    }])
    profile = CanonProviderProfile(
        profile_id="provider-openai",
        label="OpenAI",
        provider="openai",
        api_key="sk-private-test",
    )

    result = CanonAgentService(transport).run(profile, "gpt-writing", evidence, locale)

    assert result == response
    assert expected_language in transport.requests[0]["body"]["instructions"]
    assert "ProjectPatch" in transport.requests[0]["body"]["instructions"]
    request = transport.requests[0]
    assert request["url"] == "https://api.openai.com/v1/responses"
    assert request["body"]["store"] is False
    assert request["body"]["text"]["format"] == {"type": "json_object"}
    assert request["body"]["input"].startswith("Canon evidence JSON:\n{")
    assert "compact CanonAgentResponse contract" in request["body"]["instructions"]
    assert '"source_checksum"' in request["body"]["instructions"]
    assert '"operations"' in request["body"]["instructions"]
    assert len(request["body"]["instructions"]) < 2_000
    assert "response_format" not in request["body"]


@pytest.mark.parametrize("provider", ["openai", "google_gemini", "anthropic"])
@pytest.mark.parametrize(("status", "expected_code"), [
    (401, "canon_provider_credentials_invalid"),
    (400, "canon_provider_request_invalid"),
    (429, "canon_provider_rate_limited"),
    (503, "canon_provider_unavailable"),
])
def test_transport_maps_provider_status_without_exposing_body(
    monkeypatch,
    status: int,
    expected_code: str,
    provider: str,
) -> None:
    """Provider diagnostics expose a stable code and status, never response data."""

    def reject(*_args, **_kwargs):
        body = BytesIO(json.dumps({"error": {
            "code": "unsupported_value",
            "type": "invalid_request_error",
            "param": "text.format",
            "message": "secret evidence must not escape",
        }}).encode())
        raise HTTPError("https://provider.invalid", status, "secret body", {}, body)

    monkeypatch.setattr(agent_module, "urlopen", reject)

    with pytest.raises(CanonAgentError) as caught:
        UrlLibCanonAgentTransport().request_json(
            "POST",
            "https://provider.invalid/responses",
            api_key="sk-secret",
            provider=provider,
            body={"input": "evidence"},
        )

    assert caught.value.code == expected_code
    assert caught.value.parameters == {
        "status_code": status,
        "provider_error_code": "unsupported_value",
        "provider_error_type": "invalid_request_error",
        "provider_error_param": "text.format",
    }
    assert "secret" not in str(caught.value.parameters)


def test_evidence_payload_excludes_document_and_agent_output_is_validated(tmp_path: Path) -> None:
    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)
    payload = build_evidence_only_payload(check_input, candidates)
    selected = candidates[0]
    response = CanonAgentResponse(
        explanations=(CanonAgentExplanation(
            fingerprint=selected.fingerprint,
            explanation="The selected evidence conflicts with the authored state.",
            recommendation="Review the referenced transition.",
        ),),
    )

    validate_agent_response(payload, response)
    enriched = enrich_candidates(candidates, response)
    serialized = payload.model_dump_json()

    assert '"document"' not in serialized
    assert '"nodes"' not in serialized
    assert payload.facts
    assert enriched[0].fingerprint == selected.fingerprint
    assert enriched[0].agent_explanation
    assert candidates[0].agent_explanation is None


def test_agent_service_sends_only_payload_and_rejects_unknown_fingerprint(tmp_path: Path) -> None:
    check_input = _aurora_input(tmp_path)
    candidates = CanonRuleEngine().evaluate(check_input)
    payload = build_evidence_only_payload(check_input, candidates)
    malicious = CanonAgentResponse(
        explanations=(CanonAgentExplanation(
            fingerprint="f" * 64,
            explanation="Unrelated response",
        ),),
    )
    transport = _FakeTransport([{
        "choices": [{"message": {"content": malicious.model_dump_json()}}]
    }])
    profile = CanonProviderProfile(
        profile_id="provider-1",
        label="Gemini",
        provider="google_gemini",
        api_key="AIza-private-test",
    )

    with pytest.raises(CanonAgentError) as caught:
        CanonAgentService(transport).run(profile, "gemini-writing", payload, "en")

    assert caught.value.code == "canon_provider_response_invalid"
    request = transport.requests[0]
    assert request["url"].endswith("/openai/chat/completions")
    outbound = json.dumps(request["body"])
    assert check_input.document.manifest.description not in outbound
    assert profile.api_key not in outbound


def test_configured_run_enriches_issues_after_explicit_consent(tmp_path: Path) -> None:
    profiles = CanonProviderProfileRegistry(
        tmp_path / "profiles.enc",
        tmp_path / "credentials.key",
    )
    created_profile = profiles.add(
        label="Agent",
        provider="openai",
        api_key="sk-configured-secret",
    )
    fixture_payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    fixture_payload["manifest"]["settings"]["canon_check"].update({
        "agent_mode": "configured",
        "content_policy": "evidence_only",
        "model_preference": "writer-model",
        "provider_profile_id": created_profile.profile_id,
    })
    # The current settings contract resolves Canon through the shared provider
    # assignment; keep this configured fixture coherent with its legacy mirror.
    agent_providers = fixture_payload["manifest"]["settings"]["agent_providers"]
    agent_providers["default_provider_profile_id"] = created_profile.profile_id
    agent_providers["agents"]["canon_checker"].update({
        "provider_source": "project_default",
        "provider_profile_override_id": None,
        "model_id": "writer-model",
    })
    fixture_payload["manifest"]["settings"].update({
        "ui_locale": "en",
        "content_locale": "ru",
    })
    configured_fixture = tmp_path / "configured-aurora.json"
    configured_fixture.write_text(json.dumps(fixture_payload), encoding="utf-8")
    project_path = tmp_path / "ConfiguredAurora.narrative"
    import_project_fixture(configured_fixture, project_path)
    registry = ProjectSessionRegistry()
    opened = registry.open(project_path)
    check_input = registry.capture_canon_input(opened.session.session_id)
    source = check_input.document
    selected = next(
        item
        for item in CanonRuleEngine().evaluate(check_input)
        if item.rule_id == "condition.unresolved-path"
        and item.scope.owner_type == "quest_branch"
    )
    target_payload = source.model_dump(mode="python", exclude={"checksum"})
    target_payload["quests"][0]["document"]["stages"][0]["branches"][0]["condition"] = (
        "flags.ledger_acquired == true"
    )
    provider_patch = derive_project_patch(
        source,
        create_project_document(**target_payload),
    )

    class _Agent:
        def run(self, _profile, model, payload, locale):
            assert model == "writer-model"
            assert payload.content_policy == "evidence_only"
            assert locale == "ru"
            assert [item.memory_id for item in payload.approved_memory.entries] == [
                "memory-workflow-02-canon-ru"
            ]
            fixable = next(
                issue for issue in payload.issues if issue.fingerprint == selected.fingerprint
            )
            return CanonAgentResponse(explanations=(CanonAgentExplanation(
                fingerprint=fixable.fingerprint,
                explanation="Provider explanation",
                recommendation="Use the ledger acquisition flag.",
            ),), proposals=(CanonAgentPatchProposal(
                fingerprint=fixable.fingerprint,
                patch=provider_patch,
            ),))

    try:
        coordinator = CanonRunCoordinator(
            registry,
            provider_profiles=profiles,
            agent=_Agent(),
        )
        run = coordinator.start(CanonRunStart(
            session_id=opened.session.session_id,
            observed_saved_revision=opened.session.saved_revision,
            expected_history_revision=0,
            mode="configured_agent",
            remote_consent=True,
        ))

        assert run.status == "completed", run.diagnostics
        assert run.diagnostics == ()
        issues = coordinator.list_issues(opened.session.project_id).issues
        enriched = next(
            issue for issue in issues if issue.metadata.agent_explanation == "Provider explanation"
        )
        suggestion = coordinator.request_suggestion(
            enriched.id,
            opened.session.session_id,
            enriched.repair.source_checksum,
        ).suggestion
        assert suggestion is not None
        assert suggestion.why == "Provider explanation"
        assert suggestion.how == "Use the ledger acquisition flag."
        assert suggestion.patch.source_checksum == registry.inspect(
            opened.session.session_id
        ).document.checksum
        approved = coordinator.decide_suggestion(
            suggestion.id,
            command=CanonFixSuggestionDecision(
                session_id=opened.session.session_id,
                expected_history_revision=1,
            ),
            approved=True,
        )
        assert approved.suggestion.status == "approved"
    finally:
        registry.discard(opened.session.session_id)
        registry.close(opened.session.session_id)
