"""Secret-free API and provider contracts for the optional Canon agent."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent_memory import ApprovedAgentMemoryV1
from .canon_check import CanonEvidenceRef, CanonFact, CanonOwnerRef
from .project_patch import ProjectPatch

CanonProvider = Literal["openai", "google_gemini", "anthropic"]
AgentModelCapability = Literal["text_generation", "structured_output"]


class CanonAgentContract(BaseModel):
    """Reject provider extensions that could bypass the reviewed boundary."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class CanonProviderProfileSummary(CanonAgentContract):
    profile_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    provider: CanonProvider


class CanonProviderProfileCreate(CanonAgentContract):
    """Accept a key once; response models deliberately have no secret field."""

    session_id: str | None = Field(default=None, min_length=1)
    label: str = Field(min_length=1)
    provider: CanonProvider
    api_key: str = Field(repr=False)

    @field_validator("label")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized


class CanonProviderProfileUpdate(CanonAgentContract):
    """Update metadata and optionally rotate a key without returning either key."""

    session_id: str | None = Field(default=None, min_length=1)
    label: str = Field(min_length=1)
    provider: CanonProvider
    api_key: str | None = Field(default=None, repr=False)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized


class CanonProviderProfileDeleteResponse(CanonAgentContract):
    deleted_profile_id: str = Field(min_length=1)


class CanonProviderProfilesResponse(CanonAgentContract):
    profiles: tuple[CanonProviderProfileSummary, ...] = ()


class CanonProviderModel(CanonAgentContract):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    owned_by: str | None = None
    capabilities: tuple[AgentModelCapability, ...] = (
        "text_generation",
        "structured_output",
    )

    @field_validator("capabilities")
    @classmethod
    def normalize_capabilities(
        cls, values: tuple[AgentModelCapability, ...]
    ) -> tuple[AgentModelCapability, ...]:
        order = ("text_generation", "structured_output")
        selected = set(values)
        return tuple(item for item in order if item in selected)


class CanonProviderModelsResponse(CanonAgentContract):
    profile: CanonProviderProfileSummary
    models: tuple[CanonProviderModel, ...]


class CanonAgentEvidenceIssue(CanonAgentContract):
    """Minimal issue slice allowed to cross the remote provider boundary."""

    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    rule_id: str = Field(min_length=1)
    category: str = Field(min_length=1)
    severity: Literal["info", "warning", "critical"]
    targets: tuple[CanonOwnerRef, ...]
    evidence: tuple[CanonEvidenceRef, ...]


class CanonAgentEvidencePayload(CanonAgentContract):
    """Inspectable payload that cannot contain the complete project document."""

    payload_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    content_policy: Literal["evidence_only"] = "evidence_only"
    approved_memory: ApprovedAgentMemoryV1
    facts: tuple[CanonFact, ...]
    issues: tuple[CanonAgentEvidenceIssue, ...]


class CanonAgentExplanation(CanonAgentContract):
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    explanation: str = Field(min_length=1, max_length=4000)
    recommendation: str | None = Field(default=None, min_length=1, max_length=4000)


class CanonAgentPatchProposal(CanonAgentContract):
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    patch: ProjectPatch


class CanonAgentResponse(CanonAgentContract):
    """Only explanations and reviewable patches may leave provider validation."""

    response_version: Literal[1] = 1
    explanations: tuple[CanonAgentExplanation, ...] = ()
    proposals: tuple[CanonAgentPatchProposal, ...] = ()

    @model_validator(mode="after")
    def reject_duplicate_fingerprints(self) -> "CanonAgentResponse":
        for values in (self.explanations, self.proposals):
            fingerprints = [item.fingerprint for item in values]
            if len(fingerprints) != len(set(fingerprints)):
                raise ValueError("canon agent response contains duplicate fingerprints")
        return self
