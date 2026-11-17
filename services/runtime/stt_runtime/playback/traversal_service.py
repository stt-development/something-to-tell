from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.playback import (
    PlaybackCallFrame,
    PlaybackChoice,
    PlaybackCanonicalNode,
    PlaybackConditionResult,
    PlaybackDefinition,
    PlaybackDialogueLine,
    PlaybackDialogueOption,
    PlaybackDialoguePath,
    PlaybackDialogueSelection,
    PlaybackDialogueStep,
    PlaybackFact,
    PlaybackFactCode,
    PlaybackFactLevel,
    PlaybackPreparation,
    PlaybackSession,
    PlaybackState,
    PlaybackStep,
    PlaybackTerminalExit,
    PlaybackTraceEntry,
    PlaybackTraceEvent,
)
from ..schemas.composable_story_flow import FlowInvocation
from ..schemas.narrative_state import StateHolderRef
from ..schemas.playback_api import PlaybackPrepareCommand
from ..schemas.story_flow import FlowTransition
from .condition_evaluator import ConditionEvaluator, LarkConditionEvaluator
from .definition_builder import build_playback_definition
from .effect_application import apply_playback_effects

Clock = Callable[[], datetime]
IdFactory = Callable[[], str]


class PlaybackSessionServiceError(ValueError):
    """Stable command error returned by the ephemeral Playback API adapter."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class _SessionRecord:
    definition: PlaybackDefinition
    session: PlaybackSession
    stale: bool = False
    stale_revision: str | None = None


@dataclass
class _ExitResolution:
    flow_id: str
    node_id: str
    state: PlaybackState
    call_stack: list[PlaybackCallFrame]
    terminal_exit: PlaybackTerminalExit | None
    events: list[PlaybackTraceEvent]
    applied_effect_ids: list[str]
    state_changes: list
    facts: list[PlaybackFact]


class PlaybackSessionService:
    """Repository-neutral deterministic session engine with process-local state."""

    def __init__(
        self,
        *,
        evaluator: ConditionEvaluator | None = None,
        clock: Clock | None = None,
        id_factory: IdFactory | None = None,
    ) -> None:
        self._evaluator = evaluator or LarkConditionEvaluator()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory or (lambda: str(uuid4()))
        self._records: dict[str, _SessionRecord] = {}

    def prepare(self, command: PlaybackPrepareCommand) -> PlaybackPreparation:
        """Build one immutable definition without reading or writing a repository."""

        return build_playback_definition(
            command.snapshot,
            command.canonical_nodes,
            command.dialogue_documents,
            command.quest_documents,
            command.typed_effects,
            command.initial_state,
            source_revision=command.source_revision,
            snapshots=command.snapshots,
        )

    def start(
        self,
        definition: PlaybackDefinition,
        *,
        initial_state: PlaybackState | None = None,
        visit_threshold: int = 3,
    ) -> PlaybackSession:
        if not 1 <= visit_threshold <= 1000:
            raise PlaybackSessionServiceError(
                "playback_invalid_visit_threshold",
                "Playback visit threshold must be between 1 and 1000.",
            )
        owned_definition = definition.model_copy(deep=True)
        session_id = self._id_factory()
        session = self._create_initial_session(
            session_id,
            owned_definition,
            initial_state,
            visit_threshold,
        )
        self._records[session_id] = _SessionRecord(
            definition=owned_definition,
            session=session,
        )
        return session.model_copy(deep=True)

    def inspect(self, session_id: str, source_revision: str) -> PlaybackSession:
        record = self._require_record(session_id)
        self._require_current_revision(record, source_revision)
        return record.session.model_copy(deep=True)

    def invalidate_project(self, project_id: str) -> int:
        """Block every active definition after a successful authoring boundary."""

        invalidated = 0
        for record in self._records.values():
            if record.definition.project_id != project_id or record.stale:
                continue
            self._mark_stale(record, stale_revision=None)
            invalidated += 1
        return invalidated

    def choose(
        self,
        session_id: str,
        transition_id: str | None,
        *,
        dialogue_option_id: str | None = None,
        source_revision: str,
        allow_visit_threshold: bool = False,
    ) -> PlaybackSession:
        record = self._require_record(session_id)
        self._require_current_revision(record, source_revision)
        if record.stale:
            return record.session.model_copy(deep=True)
        session = record.session
        if session.status == "ended":
            raise PlaybackSessionServiceError(
                "playback_session_ended",
                "Playback session has already reached an ending.",
            )
        if session.current_node_id is None or session.step is None:
            raise PlaybackSessionServiceError(
                "playback_session_not_active",
                "Playback session has no current step.",
            )
        if dialogue_option_id is not None:
            return self._choose_dialogue_option(record, dialogue_option_id)
        if transition_id is None:
            raise PlaybackSessionServiceError(
                "playback_choice_not_found",
                "Playback transition choice is missing.",
            )
        choice = next(
            (item for item in session.step.choices if item.transition_id == transition_id),
            None,
        )
        if choice is None:
            raise PlaybackSessionServiceError(
                "playback_choice_not_found",
                f"Playback choice not found: {transition_id}",
            )
        if not choice.eligible:
            raise PlaybackSessionServiceError(
                "playback_choice_ineligible",
                choice.disabled_reason or "Playback choice is not eligible.",
            )
        next_visit = self._visit_count(record, choice.target_node_id) + 1
        if next_visit > session.visit_threshold and not allow_visit_threshold:
            threshold_fact = _fact(
                "visit_threshold",
                "error",
                (
                    f"Choosing '{transition_id}' would visit '{choice.target_node_id}' "
                    f"{next_visit} times, above threshold {session.visit_threshold}."
                ),
                "Choose again with an explicit visit-threshold override or go back.",
                record.definition,
                node_id=choice.target_node_id,
                transition_id=transition_id,
            )
            session.status = "blocked"
            session.facts = _merge_facts(session.step.facts, [threshold_fact])
            return session.model_copy(deep=True)

        stack_before = [frame.model_copy(deep=True) for frame in session.call_stack]
        flow_before = session.current_flow_id or session.flow_id
        terminal_before = session.terminal_exit.model_copy(deep=True) if session.terminal_exit else None
        application = apply_playback_effects(
            record.definition,
            session.state,
            choice.effect_ids,
        )
        if not application.success:
            session.status = "blocked"
            session.facts = _merge_facts(session.step.facts, application.facts)
            return session.model_copy(deep=True)

        source_node_id = session.current_node_id
        next_flow_id = flow_before
        next_stack = [frame.model_copy(deep=True) for frame in stack_before]
        events: list[PlaybackTraceEvent] = []
        if choice.operation == "call":
            invocation = self._invocation(record.definition, choice.transition_id)
            if invocation is None:
                raise PlaybackSessionServiceError("playback_choice_not_found", f"Playback call not found: {choice.transition_id}")
            next_flow_id = invocation.target_flow_id
            bindings = [
                binding.model_copy(deep=True)
                for binding in (record.definition.composition.bindings if record.definition.composition else [])
                if binding.invocation_id == invocation.id
            ]
            next_stack.append(PlaybackCallFrame(
                invocation_id=invocation.id,
                caller_flow_id=invocation.source_flow_id,
                caller_source_node_id=invocation.source_node_id,
                callee_flow_id=invocation.target_flow_id,
                exit_bindings=bindings,
            ))
            events.append(PlaybackTraceEvent(operation="call", flow_id=flow_before, node_id=source_node_id, invocation_id=invocation.id, message=f"Called '{self._snapshot(record.definition, invocation.target_flow_id).flow.name}'."))
        else:
            events.append(PlaybackTraceEvent(operation="transition", flow_id=flow_before, node_id=source_node_id, message=f"Took transition '{choice.label or choice.transition_id}'."))
        state_after = application.state_after.model_copy(deep=True)
        if choice.target_node_id not in state_after.visited_node_ids:
            state_after.visited_node_ids.append(choice.target_node_id)
        resolution = self._resolve_named_exits(record.definition, next_flow_id, choice.target_node_id, state_after, next_stack)
        events.extend(resolution.events)
        trace = list(session.trace)
        trace.append(
            PlaybackTraceEntry(
                sequence=len(trace),
                node_id=source_node_id,
                transition_id=choice.transition_id,
                dialogue_path_before=session.dialogue_path.model_copy(deep=True)
                if session.dialogue_path is not None
                else None,
                condition_results=[
                    item.condition_result.model_copy(deep=True)
                    for item in session.step.choices
                    if item.condition_result is not None
                ],
                applied_effect_ids=[*application.applied_effect_ids, *resolution.applied_effect_ids],
                state_changes=[*[change.model_copy(deep=True) for change in application.changes], *resolution.state_changes],
                state_before=session.state.model_copy(deep=True),
                state_after=resolution.state,
                timestamp=self._clock(),
                events=events,
                flow_id_before=flow_before,
                flow_id_after=resolution.flow_id,
                call_stack_before=stack_before,
                call_stack_after=resolution.call_stack,
                terminal_exit_before=terminal_before,
                terminal_exit_after=resolution.terminal_exit,
            )
        )
        session.current_flow_id = resolution.flow_id
        session.call_stack = [frame.model_copy(deep=True) for frame in resolution.call_stack]
        session.terminal_exit = resolution.terminal_exit.model_copy(deep=True) if resolution.terminal_exit else None
        self._replace_current_view(
            record,
            current_node_id=resolution.node_id,
            state=resolution.state,
            trace=trace,
            dialogue_path=None,
        )
        if resolution.facts:
            record.session.status = "blocked"
            record.session.facts = _merge_facts(record.session.facts, resolution.facts)
            if record.session.step:
                record.session.step.facts = _merge_facts(record.session.step.facts, resolution.facts)
        elif resolution.terminal_exit is not None:
            record.session.status = "ended"
        return record.session.model_copy(deep=True)

    def _choose_dialogue_option(
        self,
        record: _SessionRecord,
        option_id: str,
    ) -> PlaybackSession:
        """Advance only the current Dialogue cursor and preserve Story Flow position."""

        session = record.session
        dialogue = session.step.dialogue if session.step is not None else None
        path = session.dialogue_path
        if dialogue is None or path is None or dialogue.complete:
            raise PlaybackSessionServiceError(
                "playback_dialogue_choice_unavailable",
                "The current Playback step is not waiting for a Dialogue reply.",
            )
        option = next((item for item in dialogue.options if item.option_id == option_id), None)
        if option is None:
            raise PlaybackSessionServiceError(
                "playback_dialogue_choice_not_found",
                f"Dialogue reply not found: {option_id}",
            )
        if not option.eligible:
            raise PlaybackSessionServiceError(
                "playback_dialogue_choice_ineligible",
                option.disabled_reason or "Dialogue reply is not eligible.",
            )

        state_before = session.state.model_copy(deep=True)
        option_application = apply_playback_effects(
            record.definition,
            session.state,
            self._owned_effect_ids(
                record.definition,
                "dialogue_option",
                option_id,
                context_node_id=dialogue.dialogue_node_id,
            ),
        )
        if not option_application.success:
            session.status = "blocked"
            session.facts = _merge_facts(session.facts, option_application.facts)
            session.step.facts = _merge_facts(session.step.facts, option_application.facts)
            return session.model_copy(deep=True)
        state_after = option_application.state_after.model_copy(deep=True)
        recorded = state_after.dialogue_choice_ids.setdefault(dialogue.dialogue_node_id, [])
        if option_id not in recorded:
            recorded.append(option_id)
        next_path = path.model_copy(deep=True)
        next_path.option_ids.append(option_id)
        next_dialogue = self._build_dialogue_step(
            record.definition,
            dialogue.dialogue_node_id,
            state_after,
            next_path,
        )
        outcome_effect_ids = (
            self._owned_effect_ids(
                record.definition,
                "dialogue_element",
                next_dialogue.outcome_element_id,
                context_node_id=dialogue.dialogue_node_id,
            )
            if next_dialogue is not None and next_dialogue.complete and next_dialogue.outcome_element_id is not None
            else []
        )
        outcome_application = apply_playback_effects(record.definition, state_after, outcome_effect_ids)
        if not outcome_application.success:
            session.status = "blocked"
            session.facts = _merge_facts(session.facts, outcome_application.facts)
            session.step.facts = _merge_facts(session.step.facts, outcome_application.facts)
            return session.model_copy(deep=True)
        state_after = outcome_application.state_after.model_copy(deep=True)
        applied_effect_ids = [*option_application.applied_effect_ids, *outcome_application.applied_effect_ids]
        state_changes = [*option_application.changes, *outcome_application.changes]
        trace = list(session.trace)
        trace.append(
            PlaybackTraceEntry(
                sequence=len(trace),
                node_id=session.current_node_id,
                dialogue_option_id=option_id,
                dialogue_path_before=path.model_copy(deep=True),
                dialogue_path_after=next_path.model_copy(deep=True),
                applied_effect_ids=applied_effect_ids,
                state_changes=state_changes,
                state_before=state_before,
                state_after=state_after.model_copy(deep=True),
                timestamp=self._clock(),
                events=[PlaybackTraceEvent(operation="dialogue", flow_id=session.current_flow_id or session.flow_id, node_id=session.current_node_id, message=f"Selected Dialogue reply '{option.text}'.")],
                flow_id_before=session.current_flow_id,
                flow_id_after=session.current_flow_id,
                call_stack_before=session.call_stack,
                call_stack_after=session.call_stack,
                terminal_exit_before=session.terminal_exit,
                terminal_exit_after=session.terminal_exit,
            )
        )
        self._replace_current_view(
            record,
            current_node_id=session.current_node_id,
            state=state_after,
            trace=trace,
            dialogue_path=next_path,
        )
        return record.session.model_copy(deep=True)

    def back(
        self,
        session_id: str,
        *,
        source_revision: str,
    ) -> PlaybackSession:
        record = self._require_record(session_id)
        self._require_current_revision(record, source_revision)
        if record.stale:
            return record.session.model_copy(deep=True)
        if not record.session.trace:
            raise PlaybackSessionServiceError(
                "playback_back_unavailable",
                "Playback is already at the initial state boundary.",
            )
        trace = list(record.session.trace)
        boundary = trace.pop()
        record.session.current_flow_id = boundary.flow_id_before or record.session.flow_id
        record.session.call_stack = [frame.model_copy(deep=True) for frame in boundary.call_stack_before]
        record.session.terminal_exit = boundary.terminal_exit_before.model_copy(deep=True) if boundary.terminal_exit_before else None
        self._replace_current_view(
            record,
            current_node_id=boundary.node_id,
            state=boundary.state_before.model_copy(deep=True),
            trace=trace,
            dialogue_path=boundary.dialogue_path_before,
        )
        return record.session.model_copy(deep=True)

    def restart(
        self,
        session_id: str,
        definition: PlaybackDefinition,
        *,
        initial_state: PlaybackState | None = None,
        visit_threshold: int | None = None,
    ) -> PlaybackSession:
        record = self._require_record(session_id)
        replacement = definition.model_copy(deep=True)
        current_flow = record.definition.flow_snapshot.flow
        replacement_flow = replacement.flow_snapshot.flow
        if (
            replacement.project_id != record.definition.project_id
            or replacement_flow.id != current_flow.id
        ):
            raise PlaybackSessionServiceError(
                "playback_restart_ownership_mismatch",
                "Playback restart definition must own the same project and Story Flow.",
            )
        if (
            record.stale
            and record.stale_revision is not None
            and replacement.source_revision != record.stale_revision
        ):
            raise PlaybackSessionServiceError(
                "playback_restart_stale_definition",
                (
                    "Playback restart definition does not match the authored "
                    "revision that invalidated this session."
                ),
            )
        threshold = record.session.visit_threshold if visit_threshold is None else visit_threshold
        if not 1 <= threshold <= 1000:
            raise PlaybackSessionServiceError(
                "playback_invalid_visit_threshold",
                "Playback visit threshold must be between 1 and 1000.",
            )
        session = self._create_initial_session(
            session_id,
            replacement,
            initial_state,
            threshold,
        )
        record.definition = replacement
        record.session = session
        record.stale = False
        record.stale_revision = None
        return session.model_copy(deep=True)

    def close(self, session_id: str) -> None:
        self._require_record(session_id)
        del self._records[session_id]

    def _create_initial_session(
        self,
        session_id: str,
        definition: PlaybackDefinition,
        initial_state: PlaybackState | None,
        visit_threshold: int,
    ) -> PlaybackSession:
        state = self._initialize_state(definition, initial_state)
        entry_node_id = definition.flow_snapshot.flow.entry_node_id
        if entry_node_id is None:
            raise PlaybackSessionServiceError(
                "playback_invalid_entry",
                "Playback definition has no entry node.",
            )
        entry_effect_ids = self._node_effect_ids(definition, entry_node_id, definition.flow_snapshot.flow.id)
        application = apply_playback_effects(definition, state, entry_effect_ids)
        if application.success:
            state = application.state_after
            if entry_node_id not in state.visited_node_ids:
                state.visited_node_ids.append(entry_node_id)
        node = _nodes_by_id(definition)[entry_node_id]
        provisional = PlaybackSession(
            id=session_id,
            project_id=definition.project_id,
            flow_id=definition.flow_snapshot.flow.id,
            current_flow_id=definition.flow_snapshot.flow.id,
            source_revision=definition.source_revision,
            visit_threshold=visit_threshold,
            status="active",
            current_node_id=entry_node_id,
            state=state,
            step=PlaybackStep(
                node_id=node.id,
                node_kind=node.type,
                title=node.title,
                summary=node.summary,
            ),
        )
        record = _SessionRecord(definition=definition, session=provisional)
        if not application.success:
            provisional.status = "blocked"
            provisional.facts = list(application.facts)
            provisional.step.facts = list(application.facts)
            return provisional
        self._replace_current_view(
            record,
            current_node_id=entry_node_id,
            state=state,
            trace=[],
        )
        resolution = self._resolve_named_exits(definition, definition.flow_snapshot.flow.id, entry_node_id, state, [])
        if resolution.terminal_exit is not None:
            record.session.terminal_exit = resolution.terminal_exit
            record.session.status = "ended"
        return record.session

    def _initialize_state(
        self,
        definition: PlaybackDefinition,
        initial_state: PlaybackState | None,
    ) -> PlaybackState:
        state = (initial_state or definition.initial_state).model_copy(deep=True)
        if state.visited_node_ids or state.applied_effect_ids:
            raise PlaybackSessionServiceError(
                "playback_invalid_initial_state",
                "Initial Playback state cannot contain visits or applied effect ids.",
            )
        nodes = _nodes_by_id(definition)
        if any(
            node_id not in nodes or nodes[node_id].type != "Item"
            for node_id in state.inventory_node_ids
        ):
            raise PlaybackSessionServiceError(
                "playback_invalid_initial_state",
                "Initial inventory contains an unknown Item target.",
            )
        holder_node_types = {"character": "Character", "location": "Location", "faction": "Faction"}
        for item_id, holder in state.item_holders.items():
            if item_id not in nodes or nodes[item_id].type != "Item":
                raise PlaybackSessionServiceError(
                    "playback_invalid_initial_state",
                    "Initial custody contains an unknown Item target.",
                )
            expected_kind = holder_node_types.get(holder.kind)
            if expected_kind is not None and (
                holder.node_id not in nodes or nodes[holder.node_id].type != expected_kind
            ):
                raise PlaybackSessionServiceError(
                    "playback_invalid_initial_state",
                    f"Initial custody contains an invalid {holder.kind} holder.",
                )
        # Custody is authoritative; legacy inventory-only callers are upgraded in memory.
        for item_id in state.inventory_node_ids:
            state.item_holders.setdefault(item_id, StateHolderRef(kind="player"))
        state.inventory_node_ids = sorted(
            item_id for item_id, holder in state.item_holders.items()
            if holder.kind in {"player", "party"}
        )
        if any(node_id not in definition.quest_documents for node_id in state.quest_states):
            raise PlaybackSessionServiceError(
                "playback_invalid_initial_state",
                "Initial quest state contains an unknown Quest target.",
            )
        if any(node_id not in definition.dialogue_documents for node_id in state.dialogue_choice_ids):
            raise PlaybackSessionServiceError(
                "playback_invalid_initial_state",
                "Initial Dialogue state contains an unknown Dialogue target.",
            )
        for node_id, document in definition.dialogue_documents.items():
            valid_choices = {
                option.id
                for element in document.elements
                if isinstance(element, DialogueChoiceElement)
                for option in element.options
            }
            if any(choice_id not in valid_choices for choice_id in state.dialogue_choice_ids.get(node_id, [])):
                raise PlaybackSessionServiceError(
                    "playback_invalid_initial_state",
                    f"Initial Dialogue state contains an unknown choice for '{node_id}'.",
                )
            state.dialogue_choice_ids.setdefault(node_id, [])
        for node_id in definition.quest_documents:
            state.quest_states.setdefault(node_id, "inactive")
        return state

    def _replace_current_view(
        self,
        record: _SessionRecord,
        *,
        current_node_id: str,
        state: PlaybackState,
        trace: list[PlaybackTraceEntry],
        dialogue_path: PlaybackDialoguePath | None = None,
    ) -> None:
        node = _nodes_by_id(record.definition)[current_node_id]
        current_dialogue_path = dialogue_path
        if node.type == "Dialogue" and current_dialogue_path is None:
            current_dialogue_path = PlaybackDialoguePath(dialogue_node_id=current_node_id)
        step, status = self._build_step(
            record.definition,
            record.session.current_flow_id or record.session.flow_id,
            current_node_id,
            state,
            current_dialogue_path,
        )
        record.session.current_node_id = current_node_id
        record.session.state = state.model_copy(deep=True)
        record.session.dialogue_path = (
            current_dialogue_path.model_copy(deep=True)
            if current_dialogue_path is not None
            else None
        )
        record.session.step = step
        record.session.trace = [entry.model_copy(deep=True) for entry in trace]
        record.session.status = status
        record.session.facts = [fact.model_copy(deep=True) for fact in step.facts]

    def _build_step(
        self,
        definition: PlaybackDefinition,
        flow_id: str,
        node_id: str,
        state: PlaybackState,
        dialogue_path: PlaybackDialoguePath | None,
    ) -> tuple[PlaybackStep, str]:
        node = _nodes_by_id(definition)[node_id]
        snapshot = self._snapshot(definition, flow_id)
        outgoing = sorted(
            (
                transition
                for transition in snapshot.transitions
                if transition.source_node_id == node_id
            ),
            key=lambda item: (item.priority, item.id),
        )
        dialogue = self._build_dialogue_step(
            definition,
            node_id,
            state,
            dialogue_path,
        )
        invocations = sorted(
            [item for item in (definition.composition.invocations if definition.composition else []) if item.source_flow_id == flow_id and item.source_node_id == node_id],
            key=lambda item: (item.priority, item.id),
        )
        if dialogue is not None and not dialogue.complete:
            facts: list[PlaybackFact] = []
            if not any(option.eligible for option in dialogue.options):
                facts.append(
                    _fact(
                        "no_eligible_transition",
                        "error",
                        f"'{node.title}' has no eligible Dialogue reply.",
                        "Repair reply conditions or add one unconditional reply.",
                        definition,
                        node_id=node_id,
                    )
                )
            status = "active" if not facts else "blocked"
            return (
                PlaybackStep(
                    node_id=node.id,
                    node_kind=node.type,
                    title=node.title,
                    summary=node.summary,
                    dialogue=dialogue,
                    facts=facts,
                ),
                status,
            )

        if dialogue is not None and dialogue.complete:
            owned = [
                transition
                for transition in outgoing
                if isinstance(transition.metadata.get("dialogue_element_id"), str)
            ]
            if owned:
                origins = {
                    dialogue.outcome_element_id,
                    *(dialogue_path.option_ids[-1:] if dialogue_path is not None else []),
                }
                outgoing = [
                    transition
                    for transition in owned
                    if transition.metadata.get("dialogue_element_id") in origins
                ]
                if not outgoing and not invocations:
                    fact = _fact(
                        "invalid_definition",
                        "error",
                        f"'{node.title}' reached a Dialogue outcome without a Story Flow transition.",
                        "Link the final line or selected reply to a Story Flow target.",
                        definition,
                        node_id=node_id,
                    )
                    return (
                        PlaybackStep(
                            node_id=node.id,
                            node_kind=node.type,
                            title=node.title,
                            summary=node.summary,
                            dialogue=dialogue,
                            facts=[fact],
                        ),
                        "blocked",
                    )
        if not outgoing and not invocations:
            ending = _fact(
                "ending_reached",
                "info",
                f"'{node.title}' has no outgoing Story Flow transition.",
                "Restart Playback, go back, or return to authoring.",
                definition,
                node_id=node_id,
            )
            return (
                PlaybackStep(
                    node_id=node.id,
                    node_kind=node.type,
                    title=node.title,
                    summary=node.summary,
                    dialogue=dialogue,
                    facts=[ending],
                ),
                "ended",
            )

        choices: list[PlaybackChoice] = []
        facts: list[PlaybackFact] = []
        for transition in outgoing:
            result = self._evaluate_transition(transition, state)
            eligible = result is None or result.status == "true"
            disabled_reason = None
            if result is not None and not eligible:
                disabled_reason = result.message
                if result.status == "invalid":
                    facts.append(_condition_fact(definition, transition, result))
            choices.append(
                PlaybackChoice(
                    transition_id=transition.id,
                    source_node_id=transition.source_node_id,
                    target_node_id=transition.target_node_id,
                    kind=transition.kind,
                    label=transition.label,
                    condition=transition.condition,
                    priority=transition.priority,
                    is_default=transition.is_default,
                    eligible=eligible and not transition.is_default,
                    disabled_reason=disabled_reason,
                    condition_result=result,
                    effect_ids=self._choice_effect_ids(definition, transition),
                )
            )
        for invocation in invocations:
            result = self._evaluate_route_condition(invocation.condition, state)
            eligible = result is None or result.status == "true"
            target = self._snapshot(definition, invocation.target_flow_id)
            entry = target.flow.entry_node_id
            if entry is None:
                continue
            choices.append(PlaybackChoice(
                transition_id=invocation.id,
                source_node_id=invocation.source_node_id,
                target_node_id=entry,
                kind="next",
                label=invocation.label or f"Enter {target.flow.name}",
                condition=invocation.condition,
                priority=invocation.priority,
                is_default=invocation.is_default,
                eligible=eligible and not invocation.is_default,
                disabled_reason=None if eligible else result.message,
                condition_result=result,
                effect_ids=[
                    *self._owned_effect_ids(definition, "flow_invocation", invocation.id),
                    *self._node_effect_ids(definition, entry, invocation.target_flow_id),
                ],
                operation="call",
                target_flow_id=invocation.target_flow_id,
            ))
        choices.sort(key=lambda item: (item.priority, item.transition_id))

        eligible_non_default = any(choice.eligible for choice in choices if not choice.is_default)
        for choice in choices:
            if choice.is_default:
                choice.eligible = not eligible_non_default
                choice.disabled_reason = (
                    None
                    if choice.eligible
                    else "Default branch is disabled while another choice is eligible."
                )

        unconditional = [
            choice
            for choice in choices
            if not choice.is_default and not choice.condition.strip() and choice.eligible
        ]
        if len(unconditional) > 1:
            facts.append(
                _fact(
                    "multiple_unconditional_transitions",
                    "warning",
                    f"'{node.title}' has multiple eligible unconditional transitions.",
                    "Convert alternatives to explicit conditioned branches or keep one continuation.",
                    definition,
                    node_id=node_id,
                )
            )

        if not any(choice.eligible for choice in choices):
            facts.append(
                _fact(
                    "no_eligible_transition",
                    "error",
                    f"'{node.title}' has outgoing transitions but none are eligible.",
                    "Repair conditions or add one default branch.",
                    definition,
                    node_id=node_id,
                )
            )
            if not any(choice.is_default for choice in choices):
                facts.append(
                    _fact(
                        "missing_default_branch",
                        "warning",
                        f"'{node.title}' has no default transition.",
                        "Add a default branch for the all-false condition case.",
                        definition,
                        node_id=node_id,
                    )
                )
            status = "blocked"
        else:
            status = "active"
        return (
            PlaybackStep(
                node_id=node.id,
                node_kind=node.type,
                title=node.title,
                summary=node.summary,
                dialogue=dialogue,
                choices=choices,
                facts=_sorted_facts(facts),
            ),
            status,
        )

    def _build_dialogue_step(
        self,
        definition: PlaybackDefinition,
        node_id: str,
        state: PlaybackState,
        path: PlaybackDialoguePath | None,
    ) -> PlaybackDialogueStep | None:
        """Replay authored Dialogue elements until the next reply or terminal line."""

        document = definition.dialogue_documents.get(node_id)
        if document is None or path is None:
            return None
        elements = {element.id: element for element in document.elements}
        current_id = document.entry_element_id
        turns: list[PlaybackDialogueLine | PlaybackDialogueSelection] = []
        option_index = 0
        visited: set[str] = set()
        outcome_element_id: str | None = None

        while current_id is not None and current_id not in visited:
            visited.add(current_id)
            element = elements[current_id]
            if isinstance(element, DialogueLineElement):
                turns.append(
                    PlaybackDialogueLine(
                        element_id=element.id,
                        speaker_node_id=element.speaker_node_id,
                        text=element.text,
                    )
                )
                outcome_element_id = element.id
                current_id = element.next_element_id
                continue

            if option_index >= len(path.option_ids):
                options: list[PlaybackDialogueOption] = []
                for authored in element.options:
                    result = (
                        self._evaluator.evaluate(
                            {
                                "condition_version": 1,
                                "expression": authored.condition,
                            },
                            state,
                        )
                        if authored.condition.strip()
                        else None
                    )
                    eligible = result is None or result.status == "true"
                    options.append(
                        PlaybackDialogueOption(
                            choice_element_id=element.id,
                            option_id=authored.id,
                            text=authored.text,
                            condition=authored.condition,
                            eligible=eligible,
                            disabled_reason=None if eligible else result.message,
                            condition_result=result,
                        )
                    )
                return PlaybackDialogueStep(
                    dialogue_node_id=node_id,
                    prompt=element.prompt,
                    turns=turns,
                    options=options,
                )

            selected_id = path.option_ids[option_index]
            selected = next(
                (option for option in element.options if option.id == selected_id),
                None,
            )
            if selected is None:
                raise PlaybackSessionServiceError(
                    "playback_dialogue_path_invalid",
                    f"Dialogue path contains an unavailable reply: {selected_id}",
                )
            turns.append(
                PlaybackDialogueSelection(
                    choice_element_id=element.id,
                    option_id=selected.id,
                    text=selected.text,
                )
            )
            outcome_element_id = selected.id
            option_index += 1
            current_id = selected.next_element_id

        return PlaybackDialogueStep(
            dialogue_node_id=node_id,
            turns=turns,
            complete=True,
            outcome_element_id=outcome_element_id,
        )

    def _resolve_named_exits(
        self,
        definition: PlaybackDefinition,
        flow_id: str,
        node_id: str,
        state: PlaybackState,
        call_stack: list[PlaybackCallFrame],
    ) -> _ExitResolution:
        """Resolve terminal exits without splitting one reversible user command."""

        current_flow_id = flow_id
        current_node_id = node_id
        current_state = state.model_copy(deep=True)
        stack = [frame.model_copy(deep=True) for frame in call_stack]
        events: list[PlaybackTraceEvent] = []
        applied_effect_ids: list[str] = []
        state_changes: list = []
        facts: list[PlaybackFact] = []
        terminal: PlaybackTerminalExit | None = None
        composition = definition.composition
        while composition is not None:
            flow_exit = next((item for item in sorted(composition.exits, key=lambda item: item.id) if item.flow_id == current_flow_id and item.source_node_id == current_node_id), None)
            if flow_exit is None:
                break
            events.append(PlaybackTraceEvent(operation="exit", flow_id=current_flow_id, node_id=current_node_id, exit_id=flow_exit.id, message=f"Reached exit '{flow_exit.label or flow_exit.key}'."))
            exit_effects = self._owned_effect_ids(definition, "flow_exit", flow_exit.id)
            if not stack:
                application = apply_playback_effects(definition, current_state, exit_effects)
                if not application.success:
                    facts.extend(application.facts)
                    break
                current_state = application.state_after.model_copy(deep=True)
                applied_effect_ids.extend(application.applied_effect_ids)
                state_changes.extend(change.model_copy(deep=True) for change in application.changes)
                terminal = PlaybackTerminalExit(exit_id=flow_exit.id, flow_id=current_flow_id, key=flow_exit.key, label=flow_exit.label, source_node_id=current_node_id)
                break
            frame = stack[-1]
            binding = next((item for item in frame.exit_bindings if item.exit_id == flow_exit.id), None)
            if binding is None:
                facts.append(PlaybackFact(
                    code="missing_exit_binding",
                    level="error",
                    message=f"Exit '{flow_exit.label or flow_exit.key}' has no return mapping for this call site.",
                    action="Map this named exit to a caller continuation before Playback.",
                    flow_id=current_flow_id,
                    node_id=current_node_id,
                    invocation_id=frame.invocation_id,
                    exit_id=flow_exit.id,
                ))
                break
            # Exit and caller-entry effects form one return boundary for Back and diagnostics.
            target_effects = [
                *exit_effects,
                *self._node_effect_ids(definition, binding.target_node_id, frame.caller_flow_id),
            ]
            application = apply_playback_effects(definition, current_state, target_effects)
            if not application.success:
                facts.extend(application.facts)
                break
            current_state = application.state_after.model_copy(deep=True)
            applied_effect_ids.extend(application.applied_effect_ids)
            state_changes.extend(change.model_copy(deep=True) for change in application.changes)
            if binding.target_node_id not in current_state.visited_node_ids:
                current_state.visited_node_ids.append(binding.target_node_id)
            stack.pop()
            current_flow_id = frame.caller_flow_id
            current_node_id = binding.target_node_id
            events.append(PlaybackTraceEvent(operation="return", flow_id=current_flow_id, node_id=current_node_id, invocation_id=frame.invocation_id, exit_id=flow_exit.id, message=f"Returned to '{_nodes_by_id(definition)[current_node_id].title}'."))
        return _ExitResolution(current_flow_id, current_node_id, current_state, stack, terminal, events, applied_effect_ids, state_changes, facts)

    @staticmethod
    def _snapshot(definition: PlaybackDefinition, flow_id: str):
        snapshots = definition.flow_snapshots or [definition.flow_snapshot]
        snapshot = next((item for item in snapshots if item.flow.id == flow_id), None)
        if snapshot is None:
            raise PlaybackSessionServiceError("playback_flow_not_found", f"Playback Flow not found: {flow_id}")
        return snapshot

    @staticmethod
    def _invocation(definition: PlaybackDefinition, invocation_id: str) -> FlowInvocation | None:
        return next((item for item in (definition.composition.invocations if definition.composition else []) if item.id == invocation_id), None)

    def _evaluate_route_condition(self, condition: str, state: PlaybackState) -> PlaybackConditionResult | None:
        if not condition.strip():
            return None
        return self._evaluator.evaluate({"condition_version": 1, "expression": condition}, state)

    def _evaluate_transition(
        self,
        transition: FlowTransition,
        state: PlaybackState,
    ) -> PlaybackConditionResult | None:
        return self._evaluate_route_condition(transition.condition, state)

    @staticmethod
    def _choice_effect_ids(
        definition: PlaybackDefinition,
        transition: FlowTransition,
    ) -> list[str]:
        specialized_effects: list[str] = []
        quest_branch_id = transition.metadata.get("quest_branch_id")
        quest_document = definition.quest_documents.get(transition.source_node_id)
        if isinstance(quest_branch_id, str) and quest_document is not None:
            specialized_effects.extend(PlaybackSessionService._owned_effect_ids(
                definition,
                "quest_branch",
                quest_branch_id,
                context_node_id=transition.source_node_id,
            ))
            terminal = any(
                branch.id == quest_branch_id and branch.target_stage_id is None
                for stage in quest_document.stages
                for branch in stage.branches
            )
            if terminal:
                specialized_effects.extend(PlaybackSessionService._owned_effect_ids(
                    definition,
                    "quest_outcome",
                    quest_branch_id,
                    context_node_id=transition.source_node_id,
                ))
        transition_effects = PlaybackSessionService._owned_effect_ids(
            definition,
            "flow_transition",
            transition.id,
        )
        target_effects = PlaybackSessionService._node_effect_ids(
            definition,
            transition.target_node_id,
            transition.flow_id,
        )
        return specialized_effects + transition_effects + target_effects

    @staticmethod
    def _node_effect_ids(
        definition: PlaybackDefinition,
        node_id: str,
        flow_id: str | None = None,
    ) -> list[str]:
        effects = [
            effect
            for effect in definition.typed_effect_definitions
            if (
                (effect.owner_kind == "node_entry" and effect.owner_id == node_id)
                or (effect.owner_kind is None and effect.owner_node_id == node_id)
            )
            and (flow_id is None or effect.flow_id == flow_id)
        ]
        return [effect.id for effect in sorted(effects, key=lambda item: (item.application_order, item.id))]

    @staticmethod
    def _owned_effect_ids(
        definition: PlaybackDefinition,
        owner_kind: str,
        owner_id: str,
        *,
        context_node_id: str | None = None,
    ) -> list[str]:
        """Return effects for one temporal owner in authored application order."""

        effects = [
            effect
            for effect in definition.typed_effect_definitions
            if (
                effect.owner_kind == owner_kind
                and effect.owner_id == owner_id
                and (context_node_id is None or effect.context_node_id == context_node_id)
            )
            or (
                effect.owner_kind is None
                and owner_kind == "flow_transition"
                and effect.owner_transition_id == owner_id
            )
        ]
        return [effect.id for effect in sorted(effects, key=lambda item: (item.application_order, item.id))]

    def _visit_count(self, record: _SessionRecord, node_id: str) -> int:
        entry_node_id = record.definition.flow_snapshot.flow.entry_node_id
        count = 1 if entry_node_id == node_id else 0
        transitions = {
            transition.id: transition
            for transition in record.definition.flow_snapshot.transitions
        }
        for entry in record.session.trace:
            if entry.transition_id is not None:
                transition = transitions.get(entry.transition_id)
                if transition is not None and transition.target_node_id == node_id:
                    count += 1
        return count

    def _require_record(self, session_id: str) -> _SessionRecord:
        record = self._records.get(session_id)
        if record is None:
            raise PlaybackSessionServiceError(
                "playback_session_not_found",
                f"Playback session not found: {session_id}",
            )
        return record

    def _require_current_revision(
        self,
        record: _SessionRecord,
        source_revision: str,
    ) -> None:
        if record.stale:
            return
        if source_revision == record.definition.source_revision:
            return
        self._mark_stale(record, stale_revision=source_revision)

    @staticmethod
    def _mark_stale(
        record: _SessionRecord,
        *,
        stale_revision: str | None,
    ) -> None:
        """Retain one explicit Restart boundary independent of content equality."""

        stale = _fact(
            "stale_source_revision",
            "error",
            "Authored source changed after this Playback session started.",
            "Restart Playback with a freshly prepared definition.",
            record.definition,
            node_id=record.session.current_node_id,
        )
        record.stale = True
        record.stale_revision = stale_revision
        record.session.status = "blocked"
        record.session.facts = _merge_facts(record.session.facts, [stale])


def _nodes_by_id(
    definition: PlaybackDefinition,
) -> dict[str, PlaybackCanonicalNode]:
    return {node.id: node for node in definition.canonical_nodes}


def _condition_fact(
    definition: PlaybackDefinition,
    transition: FlowTransition,
    result: PlaybackConditionResult,
) -> PlaybackFact:
    code = (
        "unknown_condition_path"
        if result.diagnostic_code == "unknown_condition_path"
        else "malformed_condition"
    )
    return _fact(
        code,
        "warning",
        f"Transition '{transition.id}' condition is invalid: {result.message}",
        "Repair the transition condition before relying on this branch.",
        definition,
        node_id=transition.source_node_id,
        transition_id=transition.id,
    )


def _fact(
    code: PlaybackFactCode,
    level: PlaybackFactLevel,
    message: str,
    action: str,
    definition: PlaybackDefinition,
    *,
    node_id: str | None = None,
    transition_id: str | None = None,
    invocation_id: str | None = None,
    exit_id: str | None = None,
) -> PlaybackFact:
    return PlaybackFact(
        code=code,
        level=level,
        message=message,
        action=action,
        flow_id=definition.flow_snapshot.flow.id,
        node_id=node_id,
        transition_id=transition_id,
        invocation_id=invocation_id,
        exit_id=exit_id,
    )


def _merge_facts(
    existing: Sequence[PlaybackFact],
    additions: Sequence[PlaybackFact],
) -> list[PlaybackFact]:
    unique = {
        (
            fact.code,
            fact.flow_id,
            fact.node_id,
            fact.transition_id,
            fact.effect_id,
            fact.invocation_id,
            fact.exit_id,
            fact.message,
        ): fact
        for fact in [*existing, *additions]
    }
    return _sorted_facts(unique.values())


def _sorted_facts(facts: Iterable[PlaybackFact]) -> list[PlaybackFact]:
    return sorted(
        facts,
        key=lambda fact: (
            fact.code,
            fact.node_id or "",
            fact.transition_id or "",
            fact.effect_id or "",
            fact.invocation_id or "",
            fact.exit_id or "",
            fact.message,
        ),
    )
