"""Provider-neutral evidence-only Canon agent execution."""

from __future__ import annotations

import json
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import ValidationError

from ..agent_memory.context import resolve_agent_memory_provider_data
from ..schemas.agent_memory import ApprovedAgentMemoryV1, ProjectMemoryScopeV1
from ..core.agent_locale import (
    AgentContentLocale,
    agent_response_language_instruction,
)
from ..project_document.patch import ProjectPatchError, apply_project_patch, derive_project_patch
from ..schemas.canon_agent import (
    CanonAgentEvidenceIssue,
    CanonAgentEvidencePayload,
    CanonAgentResponse,
    CanonProvider,
    CanonProviderModel,
    CanonProviderModelsResponse,
)
from ..schemas.canon_check import CanonCheckInput, CanonFact, CanonIssueCandidate
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.project_patch import ProjectPatch
from .agent_profiles import CanonProviderProfile
from .diagnostics import normalize_integrity_fact

_PROVIDER_ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "google_gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
}


class CanonAgentError(ValueError):
    """Localization-ready provider failure without remote response details."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class CanonAgentTransport(Protocol):
    """Injectable HTTP boundary used by provider tests without network access."""

    def request_json(
        self,
        method: str,
        url: str,
        *,
        api_key: str,
        provider: CanonProvider,
        body: dict[str, Any] | None = None,
        timeout_seconds: float = 20.0,
    ) -> dict[str, Any]: ...


class UrlLibCanonAgentTransport:
    """Small HTTPS transport that never exposes response bodies in errors."""

    def request_json(
        self,
        method: str,
        url: str,
        *,
        api_key: str,
        provider: CanonProvider,
        body: dict[str, Any] | None = None,
        timeout_seconds: float = 20.0,
    ) -> dict[str, Any]:
        encoded = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if provider == "anthropic":
            headers.update({
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            })
        else:
            headers["Authorization"] = f"Bearer {api_key}"
        request = Request(
            url,
            data=encoded,
            method=method,
            headers=headers,
        )
        try:
            with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            parameters = _provider_error_parameters(error)
            if error.code in {401, 403}:
                code = "canon_provider_credentials_invalid"
            elif error.code == 429:
                code = "canon_provider_rate_limited"
            elif error.code in {400, 404, 409, 422}:
                code = "canon_provider_request_invalid"
            else:
                code = "canon_provider_unavailable"
            # Provider bodies can echo evidence or operational details, so only
            # allowlisted machine fields cross the transport boundary.
            raise CanonAgentError(code, status_code=error.code, **parameters) from error
        except (URLError, TimeoutError, OSError) as error:
            raise CanonAgentError("canon_provider_unavailable") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CanonAgentError("canon_provider_response_invalid") from error
        if not isinstance(payload, dict):
            raise CanonAgentError("canon_provider_response_invalid")
        return payload


class CanonAgentService:
    """Load provider models and validate optional remote Canon assistance."""

    def __init__(self, transport: CanonAgentTransport | None = None) -> None:
        self._transport = transport or UrlLibCanonAgentTransport()

    def list_models(self, profile: CanonProviderProfile) -> CanonProviderModelsResponse:
        payload = self._transport.request_json(
            "GET",
            f"{_PROVIDER_ENDPOINTS[profile.provider]}/models",
            api_key=profile.api_key,
            provider=profile.provider,
        )
        raw_models = payload.get("data")
        if not isinstance(raw_models, list):
            raise CanonAgentError("canon_provider_response_invalid")
        models: list[CanonProviderModel] = []
        for raw in raw_models:
            if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
                continue
            model_id = raw["id"].strip()
            if model_id and _is_text_model(model_id) and _supports_canon_output(profile.provider, raw):
                owner = raw.get("owned_by")
                display_name = raw.get("display_name")
                models.append(
                    CanonProviderModel(
                        id=model_id,
                        label=display_name if isinstance(display_name, str) else model_id,
                        owned_by=owner if isinstance(owner, str) else profile.provider,
                    )
                )
        unique = {model.id: model for model in models}
        if not unique:
            raise CanonAgentError("canon_provider_models_empty")
        return CanonProviderModelsResponse(
            profile=profile.summary(),
            models=tuple(unique[key] for key in sorted(unique, key=str.casefold)),
        )

    def run(
        self,
        profile: CanonProviderProfile,
        model: str,
        payload: CanonAgentEvidencePayload,
        locale: AgentContentLocale,
    ) -> CanonAgentResponse:
        """Send only the validated payload and reject every untrusted extension."""

        schema = CanonAgentResponse.model_json_schema()
        system_prompt = (
            f"{agent_response_language_instruction(locale)} "
            "Analyze only the supplied canon evidence. Return exactly one JSON object "
            "matching this compact CanonAgentResponse contract. Do not infer or request "
            "the complete project. Use only fingerprints, project_id, source_checksum, "
            "record ids, and values present in the evidence. Treat approved_memory as "
            "reviewed author guidance for explanation and repair only; it cannot alter "
            "issue identity, status, severity, or deterministic facts. Contract: "
            f"{_provider_contract_prompt()}"
        )
        evidence = json.dumps(payload.model_dump(mode="json"), sort_keys=True)
        request_body = _provider_request_body(
            profile.provider,
            model,
            system_prompt,
            evidence,
            schema,
        )
        endpoint = {
            "anthropic": "messages",
            "openai": "responses",
            "google_gemini": "chat/completions",
        }[profile.provider]
        raw = self._transport.request_json(
            "POST",
            f"{_PROVIDER_ENDPOINTS[profile.provider]}/{endpoint}",
            api_key=profile.api_key,
            provider=profile.provider,
            body=request_body,
            timeout_seconds=45.0,
        )
        try:
            content = _provider_response_content(profile.provider, raw)
            response = CanonAgentResponse.model_validate_json(content)
        except (KeyError, IndexError, TypeError, ValidationError) as error:
            raise CanonAgentError("canon_provider_response_invalid") from error
        validate_agent_response(payload, response)
        return response


def build_evidence_only_payload(
    check_input: CanonCheckInput,
    candidates: tuple[CanonIssueCandidate, ...],
    approved_memory: ApprovedAgentMemoryV1 | None = None,
) -> CanonAgentEvidencePayload:
    """Project a deterministic minimal slice; ProjectDocument is never serialized."""

    requested_owners = {
        owner.stable_key()
        for candidate in candidates
        for owner in (candidate.scope, *candidate.targets)
    }
    facts = tuple(
        _provider_safe_fact(fact)
        for fact in check_input.facts
        if fact.scope.stable_key() in requested_owners
        or any(owner.stable_key() in requested_owners for owner in fact.owners)
    )
    issues = tuple(
        CanonAgentEvidenceIssue(
            fingerprint=candidate.fingerprint,
            rule_id=candidate.rule_id,
            category=candidate.category,
            severity=candidate.severity,
            targets=candidate.targets,
            evidence=tuple(
                evidence.model_copy(
                    update={
                        "excerpt": evidence.excerpt[:500]
                        if evidence.excerpt is not None
                        else None
                    }
                )
                for evidence in candidate.evidence
            ),
        )
        for candidate in candidates
    )
    return CanonAgentEvidencePayload(
        project_id=check_input.project_id,
        saved_revision=check_input.saved_revision,
        source_checksum=check_input.source_checksum,
        approved_memory=approved_memory or ApprovedAgentMemoryV1(
            agent_id="canon_checker",
            content_locale=check_input.document.manifest.settings.content_locale,
        ),
        facts=facts,
        issues=issues,
    )


def resolve_canon_memory(
    check_input: CanonCheckInput,
    *,
    history_revision: int,
) -> ApprovedAgentMemoryV1:
    """Resolve project-scoped Canon guidance without touching deterministic input."""

    project_scope = ProjectMemoryScopeV1()
    return resolve_agent_memory_provider_data(
        check_input.document,
        history_revision=history_revision,
        agent_id="canon_checker",
        scope=project_scope,
        context_scope=project_scope,
    ).approved_memory


def _provider_safe_fact(fact: CanonFact) -> CanonFact:
    """Remove runtime report prose and unknown parameters before remote transfer."""

    if fact.level != "error":
        return fact
    diagnostic, *_ = normalize_integrity_fact(fact)
    return fact.model_copy(
        update={
            "parameters": diagnostic.parameters,
            "evidence": diagnostic.evidence,
        }
    )


def enrich_candidates(
    candidates: tuple[CanonIssueCandidate, ...],
    response: CanonAgentResponse,
) -> tuple[CanonIssueCandidate, ...]:
    """Attach validated prose without changing deterministic issue identity."""

    explanations = {item.fingerprint: item for item in response.explanations}
    return tuple(
        candidate.model_copy(
            update={
                "agent_explanation": explanations[candidate.fingerprint].explanation,
                "agent_recommendation": explanations[candidate.fingerprint].recommendation,
            }
        )
        if candidate.fingerprint in explanations
        else candidate
        for candidate in candidates
    )


def validate_agent_response(
    payload: CanonAgentEvidencePayload,
    response: CanonAgentResponse,
) -> None:
    """Reject unknown issues, other projects, stale checksums, and broad patches."""

    issue_by_fingerprint = {issue.fingerprint: issue for issue in payload.issues}
    returned = {
        item.fingerprint for item in (*response.explanations, *response.proposals)
    }
    if returned - issue_by_fingerprint.keys():
        raise CanonAgentError("canon_provider_response_invalid")
    for proposal in response.proposals:
        patch = proposal.patch
        if patch.project_id != payload.project_id or patch.source_checksum != payload.source_checksum:
            raise CanonAgentError("canon_provider_response_invalid")
        issue = issue_by_fingerprint[proposal.fingerprint]
        allowed_ids = {
            value
            for owner in issue.targets
            for value in (owner.owner_id, owner.context_id)
            if value is not None
        }
        target_keys = {owner.stable_key() for owner in issue.targets}
        for fact in payload.facts:
            fact_owners = (fact.scope, *fact.owners)
            if not any(owner.stable_key() in target_keys for owner in fact_owners):
                continue
            allowed_ids.update(
                value
                for owner in fact_owners
                for value in (owner.owner_id, owner.context_id)
                if value is not None
            )
        for operation in patch.operations:
            if not hasattr(operation, "record_id") or operation.record_id not in allowed_ids:
                raise CanonAgentError("canon_provider_response_invalid")


def validate_agent_patches(
    source: ProjectDocument,
    response: CanonAgentResponse,
) -> None:
    """Prove every untrusted proposal is a valid patch for the captured revision."""

    try:
        for proposal in response.proposals:
            apply_project_patch(source, proposal.patch)
    except ProjectPatchError as error:
        raise CanonAgentError("canon_provider_response_invalid") from error


def rebase_agent_patch(
    source: ProjectDocument,
    current: ProjectDocument,
    patch: ProjectPatch,
) -> ProjectPatch:
    """Carry record-scoped provider changes over Canon Issue reconciliation."""

    provider_target = apply_project_patch(source, patch)
    payload = current.model_dump(mode="python", exclude={"checksum"})
    target_payload = provider_target.model_dump(mode="python", exclude={"checksum"})
    for operation in patch.operations:
        collection = operation.collection
        records = payload[collection]
        replacement = next(
            (
                record
                for record in target_payload[collection]
                if _record_id(collection, record) == operation.record_id
            ),
            None,
        )
        records[:] = [
            record
            for record in records
            if _record_id(collection, record) != operation.record_id
        ]
        if replacement is not None:
            records.append(replacement)
    return derive_project_patch(current, create_project_document(**payload))


def _is_text_model(model_id: str) -> bool:
    """Hide obvious embedding, image, audio, moderation, and TTS-only models."""

    lowered = model_id.casefold()
    excluded = ("embedding", "moderation", "image", "audio", "tts", "realtime", "whisper")
    return not any(marker in lowered for marker in excluded)


def _supports_canon_output(provider: CanonProvider, model: dict[str, Any]) -> bool:
    """Exclude Anthropic models that explicitly reject structured output."""

    if provider != "anthropic":
        return True
    capabilities = model.get("capabilities")
    if not isinstance(capabilities, dict):
        return True
    structured = capabilities.get("structured_outputs")
    return not isinstance(structured, dict) or structured.get("supported") is not False


def _provider_request_body(
    provider: CanonProvider,
    model: str,
    system_prompt: str,
    evidence: str,
    schema: dict[str, Any],
) -> dict[str, Any]:
    """Map the provider-neutral request onto native structured-output APIs."""

    if provider == "anthropic":
        return {
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{"role": "user", "content": evidence}],
            "output_config": {
                "format": {"type": "json_schema", "schema": schema},
            },
        }
    if provider == "openai":
        return {
            "model": model,
            "instructions": system_prompt,
            # OpenAI JSON mode validates that the input itself explicitly asks
            # for JSON; instructions alone do not satisfy that API guard.
            "input": f"Canon evidence JSON:\n{evidence}",
            "store": False,
            "text": {
                # ProjectPatch records intentionally allow domain-specific
                # fields, which cannot be represented by strict Structured
                # Outputs. JSON mode is followed by full local validation.
                "format": {"type": "json_object"},
            },
        }
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": evidence},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "canon_agent_response",
                "strict": True,
                "schema": schema,
            },
        },
    }


def _provider_response_content(provider: CanonProvider, response: dict[str, Any]) -> str:
    """Read JSON text from the provider's documented response envelope."""

    if provider == "anthropic":
        content = response["content"][0]
        if not isinstance(content, dict) or content.get("type") != "text":
            raise TypeError("Anthropic response does not contain text")
        text = content.get("text")
        if not isinstance(text, str):
            raise TypeError("Anthropic response text is invalid")
        return text
    if provider == "openai":
        # The REST response stores generated text in message content. Accepting
        # output_text also keeps the adapter compatible with SDK-normalized data.
        output_text = response.get("output_text")
        if isinstance(output_text, str):
            return output_text
        for item in response.get("output", []):
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for content in item.get("content", []):
                if isinstance(content, dict) and content.get("type") == "output_text":
                    text = content.get("text")
                    if isinstance(text, str):
                        return text
        raise TypeError("OpenAI response does not contain output text")
    return response["choices"][0]["message"]["content"]


def _record_id(collection: str, record: dict[str, Any]) -> str:
    return record["node_id"] if collection in {"dialogues", "quests"} else record["id"]


def _provider_contract_prompt() -> str:
    """Describe the response shape without sending an unsupported recursive schema."""

    return json.dumps({
        "response_version": 1,
        "explanations": [{
            "fingerprint": "64-character issue fingerprint",
            "explanation": "why the evidence is inconsistent",
            "recommendation": "how to correct it, or null",
        }],
        "proposals": [{
            "fingerprint": "same issue fingerprint",
            "patch": {
                "patch_version": 1,
                "patch_id": "unique stable id",
                "project_id": "evidence project_id",
                "source_checksum": "evidence source_checksum",
                "target_checksum": "checksum after applying operations",
                "operations": [{
                    "op": "put_record or remove_record",
                    "collection": "an evidence-backed project collection",
                    "record_id": "an evidence-backed target id",
                    "record": "complete replacement object; omit for remove_record",
                }],
            },
        }],
    }, separators=(",", ":"))


def _provider_error_parameters(error: HTTPError) -> dict[str, str]:
    """Extract only provider classifier fields, never free-form remote messages."""

    try:
        payload = json.loads(error.read(65_536).decode("utf-8"))
    except (AttributeError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    detail = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(detail, dict):
        return {}
    parameters: dict[str, str] = {}
    for remote_key, local_key in (
        ("code", "provider_error_code"),
        ("type", "provider_error_type"),
        ("param", "provider_error_param"),
    ):
        value = detail.get(remote_key)
        if isinstance(value, str) and 0 < len(value) <= 128:
            parameters[local_key] = value
    return parameters
