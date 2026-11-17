"""Provider-safe resolution and serialization for reviewed Agent Memory."""

from pydantic import BaseModel

from .resolver import AgentMemoryResolutionError, AgentMemoryResolver, AgentMemorySnapshot
from ..schemas.agent_memory import (
    AgentMemoryAgentId,
    AgentMemoryProviderDataV1,
    AgentMemoryResolutionRequestV1,
    AgentMemoryResolutionV1,
    AgentMemoryScopeV1,
    ApprovedAgentMemoryEntryV1,
    ApprovedAgentMemoryV1,
    ProjectMemoryScopeV1,
    SceneMemoryScopeV1,
    StoryFlowMemoryScopeV1,
)
from ..schemas.project_document import ProjectDocument


def resolve_agent_memory_provider_data(
    document: ProjectDocument,
    *,
    history_revision: int,
    agent_id: AgentMemoryAgentId,
    scope: AgentMemoryScopeV1,
    context_scope: ProjectMemoryScopeV1 | SceneMemoryScopeV1 | StoryFlowMemoryScopeV1,
) -> AgentMemoryProviderDataV1:
    """Resolve one agent partition against the exact current project snapshot."""

    def wire(value: BaseModel) -> dict[str, object]:
        """Re-enter strict schema validation through JSON-compatible scope data."""

        return value.model_dump(mode="json")

    request = AgentMemoryResolutionRequestV1(
        project_id=document.manifest.project_id,
        agent_id=agent_id,
        namespace=agent_id,
        scope=wire(scope),
        content_locale=document.manifest.settings.content_locale,
        context_scope=wire(context_scope),
        source_checksum=document.checksum,
        history_revision=history_revision,
    )
    resolution = AgentMemoryResolver().resolve(
        AgentMemorySnapshot.from_document(
            document,
            history_revision=history_revision,
        ),
        request,
    )
    if resolution.status != "resolved":
        raise AgentMemoryResolutionError("agent_memory_resolution_blocked")
    return build_agent_memory_provider_data(resolution)


def build_agent_memory_provider_data(
    resolution: AgentMemoryResolutionV1,
) -> AgentMemoryProviderDataV1:
    """Quote reviewed instructions as user data and reject blocked resolution."""

    if resolution.status != "resolved":
        raise ValueError("agent_memory_resolution_blocked")
    return AgentMemoryProviderDataV1(
        approved_memory=ApprovedAgentMemoryV1(
            agent_id=resolution.agent_id,
            content_locale=resolution.content_locale,
            entries=tuple(
                ApprovedAgentMemoryEntryV1(
                    memory_id=entry.id,
                    title=entry.title,
                    instruction=entry.instruction,
                    scope=entry.scope,
                )
                for entry in resolution.entries
            ),
        )
    )
