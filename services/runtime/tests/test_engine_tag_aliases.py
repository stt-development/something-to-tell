"""Initial aliases are deterministic, bounded and never replace reviewed aliases."""

from services.runtime.stt_runtime.engine_tags.aliases import initial_target_aliases
from services.runtime.stt_runtime.schemas.engine_tags import EngineTagTargetAliasV1


def test_aliases_are_deterministic_identifiers_for_current_authoring_targets():
    assert initial_target_aliases("Dialogue.GateAnswer", []) == initial_target_aliases("Dialogue.GateAnswer", [])
    assert [(item.target, item.external_identifier) for item in initial_target_aliases("Dialogue.GateAnswer", [])] == [
        ("ink", "dialogue_gateanswer"), ("yarn_spinner", "dialogue_gateanswer"),
    ]


def test_alias_collisions_are_case_insensitive_and_target_specific():
    existing = [EngineTagTargetAliasV1(target="ink", external_identifier="STORY_MAIN"),
                EngineTagTargetAliasV1(target="ink", external_identifier="story_main_2")]
    before = list(existing)
    assert [(item.target, item.external_identifier) for item in initial_target_aliases("Story.Main", existing)] == [
        ("ink", "story_main_3"), ("yarn_spinner", "story_main"),
    ]
    assert existing == before


def test_flattened_hierarchies_and_maximum_keys_stay_unique_and_bounded():
    first = initial_target_aliases("A.B_c", [])
    second = initial_target_aliases("A_b.C", first)
    assert {item.external_identifier for item in second} == {"a_b_c_2"}
    key = "A" * 160
    assert all(len(item.external_identifier) <= 240 for item in initial_target_aliases(key, initial_target_aliases(key, [])))
