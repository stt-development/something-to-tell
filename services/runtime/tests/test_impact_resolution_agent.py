"""Provider prompt, envelope, citation, and failure coverage for P5.5-004."""

from io import BytesIO
import json
from urllib.error import HTTPError, URLError

import pytest

from services.runtime.stt_runtime.canon.agent_profiles import CanonProviderProfile
from services.runtime.stt_runtime.impact import resolution_agent as agent_module
from services.runtime.stt_runtime.impact.resolution_agent import (
    ImpactResolutionAgentError,
    ImpactResolutionAgentResponse,
    ImpactResolutionAgentService,
    UrlLibImpactResolutionTransport,
    validate_explanation_citations,
)
from services.runtime.stt_runtime.schemas.canon_check import CanonEvidenceRef, CanonOwnerRef
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactDependency,
    ImpactFinding,
    ImpactPath,
    ImpactSeed,
    impact_finding_fingerprint,
)
from services.runtime.stt_runtime.schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionContextResource,
    ImpactResolutionExplanation,
    ImpactResolutionRequest,
)

SOURCE = "a" * 64


class _FakeTransport:
    """Capture provider-safe requests and return a controlled response envelope."""

    def __init__(self, response: dict) -> None:
        self.response = response
        self.requests: list[dict] = []

    def request_json(self, method, url, **kwargs):
        self.requests.append({"method": method, "url": url, **kwargs})
        return self.response


@pytest.mark.parametrize(("locale", "expected"), [("en", "Explain only"), ("ru", "Объясни только")])
def test_openai_prompt_uses_project_locale_and_only_bounded_context(
    locale: str,
    expected: str,
) -> None:
    context, evidence = _context()
    explanation = ImpactResolutionExplanation(
        summary="The transition depends on the selected node.",
        why_it_matters=["The authored route can change."],
        assumptions=["The supplied path remains authoritative."],
        limitations=["No unrelated project prose was supplied."],
        cited_evidence=[evidence],
    )
    envelope = ImpactResolutionAgentResponse(explanation=explanation)
    transport = _FakeTransport({"output_text": envelope.model_dump_json()})
    service = ImpactResolutionAgentService(transport)

    result = service.run(_profile("openai"), "gpt-structured", context, locale)

    assert result.explanation == explanation
    assert result.alternatives == ()
    request = transport.requests[0]
    assert request["url"] == "https://api.openai.com/v1/responses"
    assert expected in request["body"]["instructions"]
    assert request["body"]["store"] is False
    assert request["body"]["input"].startswith("Impact context JSON:\n{")
    assert '"alternatives"' in request["body"]["instructions"]
    assert '"patch"' in request["body"]["instructions"]
    assert "cannot become a finding" in request["body"]["instructions"]
    provider_context = json.loads(request["body"]["input"].split("\n", maxsplit=1)[1])
    assert provider_context["approved_memory"]["entries"][0]["memory_id"] == (
        "memory-impact"
    )
    assert "project_path" not in request["body"]["input"]
    assert _profile("openai").api_key not in json.dumps(request["body"])


def test_anthropic_uses_native_structured_output_contract() -> None:
    context, _ = _context()
    explanation = ImpactResolutionExplanation(summary="Bounded explanation")
    envelope = ImpactResolutionAgentResponse(explanation=explanation)
    transport = _FakeTransport({
        "content": [{"type": "text", "text": envelope.model_dump_json()}]
    })

    result = ImpactResolutionAgentService(transport).run(
        _profile("anthropic"), "claude-structured", context, "en"
    )

    assert result.explanation == explanation
    body = transport.requests[0]["body"]
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["messages"][0]["content"].startswith("{")


def test_unknown_or_malformed_provider_evidence_is_rejected() -> None:
    context, _ = _context()
    foreign = CanonEvidenceRef(
        owner=CanonOwnerRef(owner_type="node", owner_id="foreign"),
        field_path="body",
        message_key="impact.evidence.foreign",
    )
    with pytest.raises(ImpactResolutionAgentError) as invalid_citation:
        validate_explanation_citations(
            context,
            ImpactResolutionExplanation(summary="Invented", cited_evidence=[foreign]),
        )
    assert invalid_citation.value.code == "impact_resolution_response_invalid"

    transport = _FakeTransport({"output_text": "not-json"})
    with pytest.raises(ImpactResolutionAgentError) as malformed:
        ImpactResolutionAgentService(transport).run(
            _profile("openai"), "gpt-structured", context, "en"
        )
    assert malformed.value.code == "impact_resolution_response_invalid"


@pytest.mark.parametrize(("failure", "code"), [
    (HTTPError("https://provider", 422, "bad", {}, BytesIO(b"{}")), "impact_resolution_model_incompatible"),
    (URLError("offline"), "impact_resolution_provider_unavailable"),
    (TimeoutError(), "impact_resolution_provider_timeout"),
])
def test_transport_maps_sanitized_provider_failures(monkeypatch, failure, code: str) -> None:
    def reject(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(agent_module, "urlopen", reject)
    with pytest.raises(ImpactResolutionAgentError) as raised:
        UrlLibImpactResolutionTransport().request_json(
            "POST",
            "https://provider",
            api_key="secret-key",
            provider="openai",
            body={},
            timeout_seconds=1,
        )
    assert raised.value.code == code
    assert "secret-key" not in str(raised.value.parameters)


def _context() -> tuple[ImpactResolutionContextPackage, CanonEvidenceRef]:
    source = CanonOwnerRef(owner_type="node", owner_id="source")
    target = CanonOwnerRef(owner_type="node", owner_id="target")
    evidence = CanonEvidenceRef(
        owner=target,
        field_path="body",
        message_key="impact.evidence.body",
        excerpt="Door remains closed.",
    )
    seed = ImpactSeed(resource=source)
    dependency = ImpactDependency(
        source=source,
        target=target,
        domain="flow",
        kind="flow.sequence",
        propagation="required",
        message_key="impact.dependency.flow",
        evidence=[evidence],
    )
    finding = ImpactFinding(
        id=impact_finding_fingerprint(
            seeds=[seed], target=target, domain="flow", direction="downstream"
        ),
        seeds=[seed],
        target=target,
        domain="flow",
        direction="downstream",
        impact_type="execution",
        propagation="required",
        distance=1,
        message_key="impact.finding",
        paths=[ImpactPath(
            direction="downstream",
            propagation="required",
            resources=[source, target],
            dependencies=[dependency],
        )],
    )
    request = ImpactResolutionRequest(
        impact_run_id="impact-run",
        finding_ids=[finding.id],
        source_checksum=SOURCE,
        provider_source="project_default",
        model_id="gpt-structured",
        content_consent=True,
    )
    context = ImpactResolutionContextPackage(
        project_id="project",
        saved_revision=1,
        history_revision=0,
        source_checksum=SOURCE,
        approved_memory={
            "agent_id": "impact_resolver",
            "content_locale": "en",
            "entries": [{
                "memory_id": "memory-impact",
                "title": "Planning assumption",
                "instruction": "Keep the route intentionally dangerous.",
                "scope": {"scope_version": 1, "kind": "project"},
            }],
        },
        request=request,
        findings=[finding],
        resources=[ImpactResolutionContextResource(
            resource=target,
            domain="flow",
            authored_fields={"body": "Door remains closed."},
            evidence=[evidence],
        )],
    )
    return context, evidence


def _profile(provider: str) -> CanonProviderProfile:
    return CanonProviderProfile(
        profile_id="provider-1",
        label="Provider",
        provider=provider,
        api_key="private-provider-key",
    )
