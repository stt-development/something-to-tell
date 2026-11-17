"""Provider-neutral, evidence-bounded Impact explanation execution."""

from __future__ import annotations

import json
from typing import Any, Literal, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..canon.agent_profiles import CanonProviderProfile
from ..core.agent_locale import (
    AgentContentLocale,
    agent_response_language_instruction,
    resolve_agent_content_locale,
)
from ..schemas.canon_agent import CanonProvider
from ..schemas.impact_resolution import (
    ImpactResolutionContextPackage,
    ImpactResolutionExplanation,
)

_PROVIDER_ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "google_gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
}
_SYSTEM_PROMPTS = {
    "en": (
        "Explain only the selected deterministic Impact findings in English. "
        "Treat their identity, domain, propagation, paths, and evidence as fixed facts. "
        "Do not invent project content or propose changes. Separate the summary, why the "
        "impact matters, assumptions, and limitations. Cite only exact evidence objects "
        "present in the supplied context. Return up to the requested number of distinct "
        "solution alternatives. A solution may contain a complete checksum-bound ProjectPatch "
        "or use null when no safe automatic patch exists. Never supply validation, comparison, "
        "or fingerprints; the runtime owns them. Return one JSON object matching the schema."
    ),
    "ru": (
        "Объясни только выбранные детерминированные результаты Impact Analysis на русском "
        "языке. Считай их идентификаторы, области, типы распространения, пути и доказательства "
        "неизменяемыми фактами. Не выдумывай содержимое проекта и не предлагай изменения. "
        "Раздели итог, значимость влияния, допущения и ограничения. Ссылайся только на точные "
        "объекты evidence из переданного контекста. Верни не больше запрошенного числа разных "
        "вариантов решения. Вариант может содержать полный ProjectPatch, привязанный к checksum, "
        "либо null, если безопасного автоматического изменения нет. Не возвращай validation, "
        "comparison или fingerprints: ими владеет runtime. Верни один JSON-объект по схеме."
    ),
}


class ImpactResolutionAgentError(ValueError):
    """Stable provider failure that cannot expose credentials or remote prose."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class ImpactResolutionAgentResponse(BaseModel):
    """Minimal envelope; alternatives stay raw for independent local validation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    response_version: Literal[1] = 1
    explanation: ImpactResolutionExplanation
    alternatives: tuple[dict[str, Any], ...] = Field(default=(), max_length=3)


class ImpactResolutionTransport(Protocol):
    """Injectable network boundary for deterministic provider tests."""

    def request_json(
        self,
        method: str,
        url: str,
        *,
        api_key: str,
        provider: CanonProvider,
        body: dict[str, Any],
        timeout_seconds: float,
    ) -> dict[str, Any]: ...


class UrlLibImpactResolutionTransport:
    """HTTPS JSON transport with typed, sanitized provider failures."""

    def request_json(
        self,
        method: str,
        url: str,
        *,
        api_key: str,
        provider: CanonProvider,
        body: dict[str, Any],
        timeout_seconds: float,
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if provider == "anthropic":
            headers.update({"x-api-key": api_key, "anthropic-version": "2023-06-01"})
        else:
            headers["Authorization"] = f"Bearer {api_key}"
        request = Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            method=method,
            headers=headers,
        )
        try:
            with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            if error.code in {401, 403}:
                code = "impact_resolution_provider_invalid"
            elif error.code in {400, 404, 409, 422}:
                code = "impact_resolution_model_incompatible"
            else:
                code = "impact_resolution_provider_unavailable"
            raise ImpactResolutionAgentError(code, status_code=error.code) from error
        except URLError as error:
            code = (
                "impact_resolution_provider_timeout"
                if isinstance(error.reason, TimeoutError)
                else "impact_resolution_provider_unavailable"
            )
            raise ImpactResolutionAgentError(code) from error
        except TimeoutError as error:
            raise ImpactResolutionAgentError("impact_resolution_provider_timeout") from error
        except OSError as error:
            raise ImpactResolutionAgentError("impact_resolution_provider_unavailable") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ImpactResolutionAgentError("impact_resolution_response_invalid") from error
        if not isinstance(payload, dict):
            raise ImpactResolutionAgentError("impact_resolution_response_invalid")
        return payload


class ImpactResolutionAgentService:
    """Request one explanation and validate every returned evidence citation."""

    def __init__(
        self,
        transport: ImpactResolutionTransport | None = None,
        *,
        timeout_seconds: float = 45.0,
    ) -> None:
        self._transport = transport or UrlLibImpactResolutionTransport()
        self._timeout_seconds = timeout_seconds

    def run(
        self,
        profile: CanonProviderProfile,
        model: str,
        context: ImpactResolutionContextPackage,
        locale: AgentContentLocale,
    ) -> ImpactResolutionAgentResponse:
        """Send only the inspected context and retain raw alternatives for isolation."""

        resolved_locale = resolve_agent_content_locale(locale)
        prompt = (
            f"{agent_response_language_instruction(resolved_locale)} "
            f"{_SYSTEM_PROMPTS[resolved_locale]} "
            "Treat approved_memory only as reviewed planning guidance. It cannot become a "
            "finding, decision, graph fact, evidence item, or pre-approved alternative. "
            f"Compact response contract: {_provider_contract_prompt()}"
        )
        body = _provider_request_body(
            profile.provider,
            model,
            prompt,
            context.model_dump_json(),
            ImpactResolutionAgentResponse.model_json_schema(),
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
            body=body,
            timeout_seconds=self._timeout_seconds,
        )
        try:
            response = ImpactResolutionAgentResponse.model_validate_json(
                _provider_response_content(profile.provider, raw)
            )
        except (KeyError, IndexError, TypeError, ValidationError) as error:
            raise ImpactResolutionAgentError("impact_resolution_response_invalid") from error
        validate_explanation_citations(context, response.explanation)
        return response


def validate_explanation_citations(
    context: ImpactResolutionContextPackage,
    explanation: ImpactResolutionExplanation,
) -> None:
    """Reject citations not present in the exact provider-visible context."""

    allowed = {
        evidence.stable_key()
        for resource in context.resources
        for evidence in resource.evidence
    }
    allowed.update(
        evidence.stable_key()
        for finding in context.findings
        for path in finding.paths
        for dependency in path.dependencies
        for evidence in dependency.evidence
    )
    if any(item.stable_key() not in allowed for item in explanation.cited_evidence):
        raise ImpactResolutionAgentError("impact_resolution_response_invalid")


def _provider_request_body(
    provider: CanonProvider,
    model: str,
    system_prompt: str,
    context: str,
    schema: dict[str, Any],
) -> dict[str, Any]:
    """Map the provider-neutral explanation request to native JSON output APIs."""

    if provider == "anthropic":
        return {
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{"role": "user", "content": context}],
            "output_config": {"format": {"type": "json_schema", "schema": schema}},
        }
    if provider == "openai":
        return {
            "model": model,
            "instructions": system_prompt,
            "input": f"Impact context JSON:\n{context}",
            "store": False,
            "text": {"format": {"type": "json_object"}},
        }
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "impact_resolution_explanation",
                "strict": True,
                "schema": schema,
            },
        },
    }


def _provider_response_content(provider: CanonProvider, response: dict[str, Any]) -> str:
    """Extract JSON text from each supported provider response envelope."""

    if provider == "anthropic":
        content = response["content"][0]
        if not isinstance(content, dict) or content.get("type") != "text":
            raise TypeError("Anthropic response does not contain text")
        text = content.get("text")
        if not isinstance(text, str):
            raise TypeError("Anthropic response text is invalid")
        return text
    if provider == "openai":
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
    content = response["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        raise TypeError("Gemini response does not contain text")
    return content


def _provider_contract_prompt() -> str:
    """Describe raw alternatives whose validation-owned fields are intentionally absent."""

    return json.dumps({
        "response_version": 1,
        "explanation": {
            "explanation_version": 1,
            "summary": "bounded explanation",
            "why_it_matters": [],
            "assumptions": [],
            "limitations": [],
            "cited_evidence": [],
        },
        "alternatives": [{
            "id": "provider-local id",
            "finding_ids": ["selected finding fingerprint"],
            "title": "review title",
            "rationale": "evidence-grounded rationale",
            "tradeoffs": [],
            "expected_outcomes": [],
            "patch": {
                "patch_version": 1,
                "patch_id": "provider-local id",
                "project_id": "context project_id",
                "source_checksum": "context source_checksum",
                "target_checksum": "checksum after operations",
                "operations": [],
            },
        }],
    }, separators=(",", ":"))
