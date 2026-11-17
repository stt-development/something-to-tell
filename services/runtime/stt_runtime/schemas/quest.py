from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class QuestBranch(BaseModel):
    """One stage-owned branch to another stage, an external edge, or an ending."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=255)
    condition: str = ""
    target_stage_id: str | None = Field(default=None, min_length=1)


class QuestStage(BaseModel):
    """An ordered authoring step owned by a Quest aggregate."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    branches: list[QuestBranch] = Field(default_factory=list)


class QuestDocument(BaseModel):
    """Versioned branching quest aggregate stored by one canonical Quest node."""

    model_config = ConfigDict(extra="forbid")

    quest_version: Literal[1] = 1
    objective: str = ""
    quest_giver_node_id: str | None = Field(default=None, min_length=1)
    entry_stage_id: str | None = Field(default=None, min_length=1)
    prerequisite_node_ids: list[str] = Field(default_factory=list)
    reward_node_ids: list[str] = Field(default_factory=list)
    stages: list[QuestStage] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_graph(self) -> "QuestDocument":
        self._require_unique(self.prerequisite_node_ids, "quest prerequisites")
        self._require_unique(self.reward_node_ids, "quest rewards")

        stage_ids = [stage.id for stage in self.stages]
        branch_ids = [branch.id for stage in self.stages for branch in stage.branches]
        self._require_unique(stage_ids, "quest stage ids")
        self._require_unique(branch_ids, "quest branch ids")

        stage_id_set = set(stage_ids)
        if self.stages and self.entry_stage_id is None:
            raise ValueError("non-empty quest requires an entry stage")
        if not self.stages and self.entry_stage_id is not None:
            raise ValueError("empty quest cannot have an entry stage")
        if self.entry_stage_id is not None and self.entry_stage_id not in stage_id_set:
            raise ValueError("quest entry stage does not exist")

        for stage in self.stages:
            for branch in stage.branches:
                if branch.target_stage_id is not None and branch.target_stage_id not in stage_id_set:
                    raise ValueError(f"quest branch target stage does not exist: {branch.target_stage_id}")
        return self

    @staticmethod
    def _require_unique(values: list[str], label: str) -> None:
        if len(set(values)) != len(values):
            raise ValueError(f"{label} must be unique")
