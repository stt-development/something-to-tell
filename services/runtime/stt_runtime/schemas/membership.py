from pydantic import BaseModel, ConfigDict, Field


class FactionMembershipCreate(BaseModel):
    """Identifies the existing Character to attach to a Faction."""

    model_config = ConfigDict(extra="forbid")

    character_node_id: str = Field(min_length=1)
