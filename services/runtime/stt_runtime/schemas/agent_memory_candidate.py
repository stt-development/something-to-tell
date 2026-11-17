"""Process-local lifecycle contracts for reviewed Agent Memory candidates."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from .agent_memory import (
    AgentMemoryCandidateV1,
    AgentMemoryContractModel,
    AgentMemoryIdentityModel,
    validate_agent_memory_text,
)
from .project_history import ProjectHistoryMutationResponse

AGENT_MEMORY_CANDIDATE_RUN_VERSION = 1
AGENT_MEMORY_CANDIDATE_REQUEST_VERSION = 1
AGENT_MEMORY_CANDIDATE_RETRY_VERSION = 1
AGENT_MEMORY_CANDIDATE_REVIEW_VERSION = 1
AGENT_MEMORY_CANDIDATE_RESPONSE_VERSION = 1
AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS = 1_000
AGENT_MEMORY_MAX_TARGET_CHARACTERS = 8_000

AgentMemoryCandidateRunStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "stale",
    "rejected",
    "accepted",
]


class AgentMemoryCandidateRequestV1(AgentMemoryIdentityModel):
    """Explicit consent and exact project state for one candidate generation run."""

    request_version: Literal[1] = AGENT_MEMORY_CANDIDATE_REQUEST_VERSION
    session_id: str = Field(min_length=1, max_length=128)
    observed_source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_history_revision: int = Field(ge=0)
    guidance_request: str = Field(
        min_length=1,
        max_length=AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS,
    )
    content_consent: Literal[True]

    @field_validator("guidance_request")
    @classmethod
    def validate_guidance(cls, value: str) -> str:
        return str(validate_agent_memory_text(value))


class AgentMemoryCandidateRetryV1(AgentMemoryContractModel):
    """Fresh state binding and optional refined request for an immutable retry."""

    retry_version: Literal[1] = AGENT_MEMORY_CANDIDATE_RETRY_VERSION
    observed_source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_history_revision: int = Field(ge=0)
    guidance_request: str = Field(
        min_length=1,
        max_length=AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS,
    )
    content_consent: Literal[True]

    @field_validator("guidance_request")
    @classmethod
    def validate_guidance(cls, value: str) -> str:
        return str(validate_agent_memory_text(value))


class AgentMemoryCandidateReviewV1(AgentMemoryContractModel):
    """Binds a process-local Reject action to the exact visible candidate."""

    review_version: Literal[1] = AGENT_MEMORY_CANDIDATE_REVIEW_VERSION
    candidate_id: str = Field(min_length=1, max_length=128)
    semantic_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


class AgentMemoryCandidateProviderDisclosureV1(AgentMemoryContractModel):
    """Safe provider identity excludes endpoint, key, request, and response payloads."""

    provider: Literal["openai", "google_gemini", "anthropic"]
    provider_profile_id: str = Field(min_length=1, max_length=128)
    model_id: str = Field(min_length=1, max_length=256)


class AgentMemoryCandidateRunV1(AgentMemoryContractModel):
    """Observable process-local state; only its candidate can later be accepted."""

    run_version: Literal[1] = AGENT_MEMORY_CANDIDATE_RUN_VERSION
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1, max_length=128)
    request: AgentMemoryCandidateRequestV1
    source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    history_revision: int = Field(ge=0)
    status: AgentMemoryCandidateRunStatus
    progress: int = Field(ge=0, le=100)
    predecessor_run_id: str | None = Field(default=None, min_length=1, max_length=128)
    candidate: AgentMemoryCandidateV1 | None = None
    provider_disclosure: AgentMemoryCandidateProviderDisclosureV1 | None = None
    error_code: str | None = Field(default=None, min_length=1, max_length=128)
    started_at: datetime
    completed_at: datetime | None = None

    @model_validator(mode="after")
    def validate_state(self) -> "AgentMemoryCandidateRunV1":
        if self.request.project_id != self.project_id:
            raise ValueError("candidate run request belongs to another project")
        if self.source_checksum != self.request.observed_source_checksum:
            raise ValueError("candidate run checksum differs from its request")
        if self.history_revision != self.request.expected_history_revision:
            raise ValueError("candidate run history differs from its request")
        terminal = self.status in {
            "completed", "failed", "cancelled", "stale", "rejected", "accepted"
        }
        if terminal != (self.completed_at is not None):
            raise ValueError("candidate run completion timestamp is inconsistent")
        if (self.status in {"completed", "rejected", "accepted"}) != (
            self.candidate is not None
        ):
            raise ValueError("candidate run payload is inconsistent")
        if self.candidate is not None and (
            self.candidate.project_id != self.project_id
            or self.candidate.source_checksum != self.source_checksum
            or self.candidate.history_revision != self.history_revision
        ):
            raise ValueError("candidate run payload has stale identity")
        if (self.status in {"failed", "cancelled", "stale"}) != (
            self.error_code is not None
        ):
            raise ValueError("candidate run error is inconsistent")
        return self


class AgentMemoryCandidateRunResponseV1(AgentMemoryContractModel):
    """Safe run envelope used by start, inspect, cancel, retry, and reject."""

    response_version: Literal[1] = AGENT_MEMORY_CANDIDATE_RESPONSE_VERSION
    run: AgentMemoryCandidateRunV1


class AgentMemoryCandidateAcceptanceResponseV1(AgentMemoryContractModel):
    """Returns the one history mutation and consumed process-local run."""

    response_version: Literal[1] = AGENT_MEMORY_CANDIDATE_RESPONSE_VERSION
    result: ProjectHistoryMutationResponse
    run: AgentMemoryCandidateRunV1


class AgentMemoryCandidateContextV1(AgentMemoryContractModel):
    """Minimal bounded authored target sent as untrusted provider data."""

    context_version: Literal[1] = 1
    project_name: str = Field(min_length=1, max_length=256)
    target_kind: str = Field(min_length=1, max_length=64)
    target_title: str = Field(min_length=1, max_length=256)
    target_text: str = Field(max_length=AGENT_MEMORY_MAX_TARGET_CHARACTERS)
    omitted_target_characters: int = Field(ge=0)
    guidance_request: str = Field(max_length=AGENT_MEMORY_MAX_GUIDANCE_CHARACTERS)
    content_locale: Literal["en", "ru"]
    scope: dict[str, Any]

    model_config = ConfigDict(extra="forbid", frozen=True)
