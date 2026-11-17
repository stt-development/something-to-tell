from copy import deepcopy

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.narrative_state import (
    NarrativeStateContract,
    NarrativeEffectOwnerRef,
    StateHolderRef,
    TransferItemPayload,
)


PROJECT_ID = "project-aurora"


def holder(kind: str, node_id: str | None = None) -> dict[str, object]:
    return {"holder_version": 1, "kind": kind, **({"node_id": node_id} if node_id else {})}


def owner(owner_kind: str, owner_id: str, context_node_id: str | None = None) -> dict[str, object]:
    return {
        "owner_version": 1,
        "owner_kind": owner_kind,
        "owner_id": owner_id,
        **({"context_node_id": context_node_id} if context_node_id else {}),
    }


def effect(effect_id: str, operation: str, payload: dict[str, object]) -> dict[str, object]:
    return {
        "effect_version": 1,
        "id": effect_id,
        "project_id": PROJECT_ID,
        "operation": operation,
        "payload": payload,
        "repeat_policy": "once",
        "explanation": f"Apply {operation}.",
    }


def valid_payload() -> dict[str, object]:
    owners = [
        owner("node_entry", "node-character"),
        owner("flow_transition", "transition-1"),
        owner("dialogue_element", "line-1", "node-dialogue"),
        owner("dialogue_option", "option-1", "node-dialogue"),
        owner("quest_branch", "branch-1", "node-quest"),
        owner("quest_outcome", "outcome-1", "node-quest"),
        owner("flow_invocation", "invocation-1"),
        owner("flow_exit", "exit-1"),
    ]
    effects = [
        effect(
            "effect-transfer",
            "transfer_item",
            {
                "item_node_id": "node-item",
                "from_holder": holder("character", "node-character"),
                "to_holder": holder("location", "node-location"),
            },
        ),
        effect("effect-set", "set_flag", {"flag": "harbor_open"}),
        effect("effect-clear", "clear_flag", {"flag": "alarm"}),
        effect(
            "effect-quest",
            "set_quest_status",
            {"quest_node_id": "node-quest", "status": "completed"},
        ),
        effect(
            "effect-choice",
            "record_dialogue_choice",
            {"dialogue_node_id": "node-dialogue", "choice_id": "option-1"},
        ),
    ]
    return {
        "contract_version": 1,
        "project_id": PROJECT_ID,
        "canonical_nodes": [
            {"id": "node-character", "project_id": PROJECT_ID, "type": "Character"},
            {"id": "node-location", "project_id": PROJECT_ID, "type": "Location"},
            {"id": "node-faction", "project_id": PROJECT_ID, "type": "Faction"},
            {"id": "node-item", "project_id": PROJECT_ID, "type": "Item"},
            {"id": "node-quest", "project_id": PROJECT_ID, "type": "Quest"},
            {"id": "node-dialogue", "project_id": PROJECT_ID, "type": "Dialogue"},
        ],
        "flows": [{"id": "flow-main", "project_id": PROJECT_ID}],
        "owners": [{"project_id": PROJECT_ID, "owner": record} for record in owners],
        "initial_states": [
            {
                "state_version": 1,
                "project_id": PROJECT_ID,
                "flow_id": "flow-main",
                "flags": {"harbor_open": False},
                "item_custody": [
                    {
                        "custody_version": 1,
                        "item_node_id": "node-item",
                        "holder": holder("faction", "node-faction"),
                    }
                ],
                "quest_statuses": {"node-quest": "active"},
            }
        ],
        "effects": effects,
        "bindings": [
            {
                "binding_version": 1,
                "id": f"binding-{index}",
                "project_id": PROJECT_ID,
                "effect_id": effects[index % len(effects)]["id"],
                "owner": record,
                "application_order": 0,
            }
            for index, record in enumerate(owners)
        ],
    }


def test_contract_accepts_all_holder_effect_and_owner_kinds_without_mutation() -> None:
    payload = valid_payload()
    original = deepcopy(payload)

    contract = NarrativeStateContract.model_validate(payload)

    assert payload == original
    assert contract.contract_version == 1
    assert {record.owner.owner_kind for record in contract.owners} == {
        "node_entry",
        "flow_transition",
        "dialogue_element",
        "dialogue_option",
        "quest_branch",
        "quest_outcome",
        "flow_invocation",
        "flow_exit",
    }
    assert {definition.operation for definition in contract.effects} == {
        "transfer_item",
        "set_flag",
        "clear_flag",
        "set_quest_status",
        "record_dialogue_choice",
    }


@pytest.mark.parametrize("kind", ["character", "location", "faction"])
def test_canonical_holders_require_a_node_id(kind: str) -> None:
    with pytest.raises(ValidationError, match="requires a canonical node id"):
        StateHolderRef(kind=kind)


@pytest.mark.parametrize("kind", ["player", "party", "unowned"])
def test_intrinsic_holders_forbid_a_node_id(kind: str) -> None:
    with pytest.raises(ValidationError, match="cannot reference a canonical node"):
        StateHolderRef(kind=kind, node_id="node-character")


def test_transfer_item_requires_one_distinct_source_and_destination() -> None:
    with pytest.raises(ValidationError, match="from_holder"):
        TransferItemPayload.model_validate({
            "item_node_id": "node-item",
            "to_holder": holder("player"),
        })
    with pytest.raises(ValidationError, match="to_holder"):
        TransferItemPayload.model_validate({
            "item_node_id": "node-item",
            "from_holder": holder("player"),
        })
    with pytest.raises(ValidationError, match="must differ"):
        TransferItemPayload(
            item_node_id="node-item",
            from_holder=StateHolderRef(kind="player"),
            to_holder=StateHolderRef(kind="player"),
        )


@pytest.mark.parametrize(
    ("section", "index", "message"),
    [
        ("canonical_nodes", 0, "canonical node belongs to another project"),
        ("flows", 0, "Flow belongs to another project"),
        ("owners", 0, "effect owner belongs to another project"),
        ("initial_states", 0, "initial state belongs to another project"),
        ("effects", 0, "effect belongs to another project"),
        ("bindings", 0, "binding belongs to another project"),
    ],
)
def test_every_authored_record_is_project_scoped(section: str, index: int, message: str) -> None:
    payload = valid_payload()
    payload[section][index]["project_id"] = "project-other"  # type: ignore[index]

    with pytest.raises(ValidationError, match=message):
        NarrativeStateContract.model_validate(payload)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("holder-type", "character holder must reference a Character node"),
        ("custody-type", "custody Item must reference a Item node"),
        ("quest-type", "initial Quest must reference a Quest node"),
        ("transfer-type", "transfer Item must reference a Item node"),
        ("dialogue-type", "effect Dialogue must reference a Dialogue node"),
    ],
)
def test_canonical_references_require_the_correct_node_type(mutation: str, message: str) -> None:
    payload = valid_payload()
    if mutation == "holder-type":
        payload["effects"][0]["payload"]["from_holder"]["node_id"] = "node-item"  # type: ignore[index]
    elif mutation == "custody-type":
        payload["initial_states"][0]["item_custody"][0]["item_node_id"] = "node-character"  # type: ignore[index]
    elif mutation == "quest-type":
        payload["initial_states"][0]["quest_statuses"] = {"node-item": "active"}  # type: ignore[index]
    elif mutation == "transfer-type":
        payload["effects"][0]["payload"]["item_node_id"] = "node-character"  # type: ignore[index]
    else:
        payload["effects"][4]["payload"]["dialogue_node_id"] = "node-quest"  # type: ignore[index]

    with pytest.raises(ValidationError, match=message):
        NarrativeStateContract.model_validate(payload)


def test_initial_state_rejects_duplicate_custody_and_flow_records() -> None:
    payload = valid_payload()
    custody = payload["initial_states"][0]["item_custody"][0]  # type: ignore[index]
    payload["initial_states"][0]["item_custody"].append(deepcopy(custody))  # type: ignore[index]
    with pytest.raises(ValidationError, match="assign an Item only once"):
        NarrativeStateContract.model_validate(payload)

    payload = valid_payload()
    payload["initial_states"].append(deepcopy(payload["initial_states"][0]))  # type: ignore[union-attr,index]
    with pytest.raises(ValidationError, match="one Flow may have only one initial state"):
        NarrativeStateContract.model_validate(payload)


def test_specialized_owners_require_their_matching_canonical_context() -> None:
    with pytest.raises(ValidationError, match="requires its canonical context node"):
        NarrativeEffectOwnerRef(owner_kind="dialogue_option", owner_id="option-1")

    payload = valid_payload()
    payload["owners"][2]["owner"]["context_node_id"] = "node-quest"  # type: ignore[index]
    with pytest.raises(ValidationError, match="dialogue_element context must reference a Dialogue node"):
        NarrativeStateContract.model_validate(payload)


def test_bindings_require_existing_effect_owner_and_unique_owner_order() -> None:
    payload = valid_payload()
    payload["bindings"][0]["effect_id"] = "effect-missing"  # type: ignore[index]
    with pytest.raises(ValidationError, match="missing effect"):
        NarrativeStateContract.model_validate(payload)

    payload = valid_payload()
    payload["bindings"][0]["owner"] = owner("flow_exit", "missing-exit")  # type: ignore[index]
    with pytest.raises(ValidationError, match="missing owner"):
        NarrativeStateContract.model_validate(payload)

    payload = valid_payload()
    duplicate = deepcopy(payload["bindings"][0])  # type: ignore[index]
    duplicate["id"] = "binding-duplicate-order"
    payload["bindings"].append(duplicate)  # type: ignore[union-attr]
    with pytest.raises(ValidationError, match="application order must be unique"):
        NarrativeStateContract.model_validate(payload)
