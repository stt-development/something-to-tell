from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DialogueLineElement(BaseModel):
    """A spoken line whose speaker is an existing dialogue participant."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["line"]
    speaker_node_id: str = Field(min_length=1)
    text: str = Field(min_length=1)
    next_element_id: str | None = Field(default=None, min_length=1)


class DialogueChoiceOption(BaseModel):
    """One authored answer that can continue a branch or end the dialogue."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1)
    condition: str = ""
    next_element_id: str | None = Field(default=None, min_length=1)


class DialogueChoiceElement(BaseModel):
    """A branching prompt with any number of authored answer options."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    kind: Literal["choice"]
    prompt: str = ""
    options: list[DialogueChoiceOption] = Field(default_factory=list)


# The discriminator is the owning contract for runtime dialogue element parsing.
DialogueElement = Annotated[DialogueLineElement | DialogueChoiceElement, Field(discriminator="kind")]


class DialogueDocument(BaseModel):
    """Versioned branching dialogue aggregate stored by one Dialogue node."""

    model_config = ConfigDict(extra="forbid")

    dialogue_version: Literal[1] = 1
    entry_element_id: str | None = Field(default=None, min_length=1)
    participants: list[str] = Field(default_factory=list)
    elements: list[DialogueElement] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_graph(self) -> "DialogueDocument":
        if len(set(self.participants)) != len(self.participants):
            raise ValueError("dialogue participants must be unique")

        element_ids = [element.id for element in self.elements]
        option_ids = [option.id for element in self.elements if isinstance(element, DialogueChoiceElement) for option in element.options]
        origin_ids = element_ids + option_ids
        if len(set(origin_ids)) != len(origin_ids):
            raise ValueError("dialogue element and option ids must be unique")

        element_id_set = set(element_ids)
        if self.elements and self.entry_element_id is None:
            raise ValueError("non-empty dialogue requires an entry element")
        if not self.elements and self.entry_element_id is not None:
            raise ValueError("empty dialogue cannot have an entry element")
        if self.entry_element_id is not None and self.entry_element_id not in element_id_set:
            raise ValueError("dialogue entry element does not exist")

        participant_set = set(self.participants)
        for element in self.elements:
            if isinstance(element, DialogueLineElement):
                if element.speaker_node_id not in participant_set:
                    raise ValueError(f"line speaker is not a participant: {element.speaker_node_id}")
                self._validate_next_reference(element.next_element_id, element_id_set)
            else:
                for option in element.options:
                    self._validate_next_reference(option.next_element_id, element_id_set)
        return self

    @staticmethod
    def _validate_next_reference(next_element_id: str | None, element_ids: set[str]) -> None:
        if next_element_id is not None and next_element_id not in element_ids:
            raise ValueError(f"dialogue next element does not exist: {next_element_id}")


class DialogueValidationIssue(BaseModel):
    """Stable validation detail for the dedicated dialogue runtime API."""

    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    path: str = ""
