import type { Node } from "@xyflow/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Calendar,
  CheckCircle2,
  CircleHelp,
  Database,
  FileText,
  Flag,
  GitBranch,
  ListTree,
  LoaderCircle,
  MapPin,
  MessageSquare,
  Package,
  PanelRightOpen,
  Pencil,
  Play,
  RotateCcw,
  Sparkles,
  Share2,
  Undo2,
  User,
  WifiOff,
  X,
  type LucideIcon
} from "lucide-react";
import type { NarrativeNodeData } from "../types";
import { CanonDiagnosticMarker, type CanonDiagnosticFocus } from "../canon/CanonDiagnosticMarker";
import { i18next, tr } from "../localization/i18n";
import type {
  PlaybackChoice,
  PlaybackDialogueOption,
  PlaybackDialogueStep,
  PlaybackFact,
  PlaybackSession,
  PlaybackState,
  PlaybackStateChange
} from "./contracts";

export type PlaybackWorkspaceErrorKind = "empty" | "runtime" | "unavailable";

export interface PlaybackWorkspaceError {
  kind: PlaybackWorkspaceErrorKind;
  message: string;
}

export type PlaybackSourceTarget =
  | { kind: "node"; mode: "edit" | "flow" | "relationships" | "story"; nodeId: string }
  | { kind: "transition"; transitionId: string }
  | { effectId: string; kind: "effect" }
  | { fact: PlaybackFact; kind: "fact" };

export type PlaybackSelection =
  | { id: string; kind: "transition" }
  | { id: string; kind: "dialogue" };

interface PlaybackWorkspaceProps {
  headerActions?: ReactNode;
  announcement: string;
  busy: boolean;
  error: PlaybackWorkspaceError | null;
  flowName: string;
  flowNames?: Record<string, string>;
  localFixture: boolean;
  loading: boolean;
  node: Node<NarrativeNodeData> | null;
  nodeLabels: Record<string, string>;
  onBack: () => void;
  onChoose: (selection: PlaybackSelection) => void;
  onExit: () => void;
  onOpenSource: (target: PlaybackSourceTarget) => void;
  onRestart: () => void;
  onRetry: () => void;
  preparationFacts: PlaybackFact[];
  session: PlaybackSession | null;
  transitionLabels: Record<string, string>;
  canonFocus?: CanonDiagnosticFocus | null;
}

const SLIDE_META: Record<string, { color: string; Icon: LucideIcon }> = {
  Character: { color: "#0f766e", Icon: User },
  Condition: { color: "#9333ea", Icon: CircleHelp },
  Consequence: { color: "#be123c", Icon: Sparkles },
  Dialogue: { color: "#0891b2", Icon: MessageSquare },
  Event: { color: "#a16207", Icon: Calendar },
  Faction: { color: "#4f46e5", Icon: Flag },
  Item: { color: "#15803d", Icon: Package },
  Location: { color: "#0369a1", Icon: MapPin },
  Lore: { color: "#7c3aed", Icon: BookOpen },
  Quest: { color: "#c2410c", Icon: GitBranch },
  Scene: { color: "#2563eb", Icon: BookOpen }
};

/** Renders one transient, runtime-driven author playtest above canvas modes. */
export function PlaybackWorkspace({
  headerActions,
  announcement,
  busy,
  canonFocus,
  error,
  flowName,
  flowNames = {},
  localFixture,
  loading,
  node,
  nodeLabels,
  onBack,
  onChoose,
  onExit,
  onOpenSource,
  onRestart,
  onRetry,
  preparationFacts,
  session,
  transitionLabels
}: PlaybackWorkspaceProps) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticTab, setDiagnosticTab] = useState<"facts" | "state" | "trace">("trace");
  const [selectedTraceSequence, setSelectedTraceSequence] = useState<number | null>(null);
  const selectedTraceRef = useRef<HTMLLIElement | null>(null);
  const currentStep = session?.step ?? null;
  const stale = session?.facts.some((fact) => fact.code === "stale_source_revision") ?? false;
  const latestChanges = session?.trace.at(-1)?.state_changes ?? [];
  const currentFlowName = session ? flowNames[session.current_flow_id ?? session.flow_id] ?? session.current_flow_id ?? flowName : flowName;
  const callDepth = session?.call_stack?.length ?? 0;

  useEffect(() => {
    if (selectedTraceSequence !== null && !session?.trace.some((entry) => entry.sequence === selectedTraceSequence)) {
      setSelectedTraceSequence(null);
    }
  }, [selectedTraceSequence, session?.trace]);

  useEffect(() => {
    if (diagnosticsOpen && selectedTraceSequence !== null) {
      selectedTraceRef.current?.focus();
    }
  }, [diagnosticsOpen, diagnosticTab, selectedTraceSequence]);

  function openFactTrace(fact: PlaybackFact) {
    const sequence = findFactTraceSequence(fact, session);
    if (sequence === null) return;
    setSelectedTraceSequence(sequence);
    setDiagnosticTab("trace");
    setDiagnosticsOpen(true);
  }

  return (
    <section aria-label={tr("playback.workspace")} className="playback-workspace">
      <header className="playback-header">
        <div className="playback-header-title">
          <span className="playback-product-label"><Play size={15} aria-hidden="true" /> {tr("playback.title")}</span>
          <div>
            <h1>{flowName || tr("playback.storyFlow")}</h1>
            <p>{currentStep ? `${currentFlowName} · ${displayKind(currentStep.node_kind)} · ${currentStep.title}` : tr("playback.authorPlaytest")}</p>
            {callDepth ? <span aria-label={tr("playback.callDepth", { count: callDepth })} className="playback-call-depth"><GitBranch size={12} aria-hidden="true" />{tr("playback.insideFlow", { name: currentFlowName, count: callDepth })}</span> : null}
          </div>
        </div>
        <div className="playback-header-actions">
          {headerActions}
          <button
            className="playback-command-button"
            disabled={busy || stale || !session?.trace.length}
            onClick={onBack}
            type="button"
          >
            <Undo2 size={15} aria-hidden="true" />
            {tr("playback.back")}
          </button>
          <button
            className="playback-command-button"
            disabled={busy || !session}
            onClick={onRestart}
            type="button"
          >
            <RotateCcw size={15} aria-hidden="true" />
            {tr("playback.restart")}
          </button>
          <button
            aria-pressed={diagnosticsOpen}
            className={`playback-command-button ${diagnosticsOpen ? "playback-command-active" : ""}`}
            disabled={!session}
            onClick={() => setDiagnosticsOpen((value) => !value)}
            type="button"
          >
            <PanelRightOpen size={15} aria-hidden="true" />
            {tr("playback.diagnostics")}
          </button>
          {localFixture ? <span className="playback-fixture-badge"><WifiOff size={13} aria-hidden="true" />{tr("playback.localFixture")}</span> : <span className="playback-runtime-badge">{tr("playback.runtime")}</span>}
          <button aria-label={tr("playback.exit")} className="playback-exit-button" onClick={onExit} type="button">
            <X size={17} aria-hidden="true" />
            {tr("playback.exit")}
          </button>
        </div>
      </header>

      {canonFocus ? (
        <div className="playback-canon-diagnostic" data-canon-owner-id={canonFocus.owner.owner_id} tabIndex={-1}>
          <CanonDiagnosticMarker focus={canonFocus} />
        </div>
      ) : null}

      {loading ? (
        <PlaybackStateMessage
          Icon={LoaderCircle}
          busy
          message={tr("playback.preparingMessage")}
          title={tr("playback.preparing")}
        />
      ) : error ? (
        <div className="playback-error-layout">
          <PlaybackStateMessage
            Icon={error.kind === "empty" ? CircleHelp : AlertTriangle}
            actionLabel={error.kind === "empty" ? undefined : tr("playback.tryAgain")}
            message={error.message}
            onAction={error.kind === "empty" ? undefined : onRetry}
            title={error.kind === "empty" ? tr("playback.emptyFlow") : error.kind === "unavailable" ? tr("playback.runtimeUnavailable") : tr("playback.startFailed")}
          />
          {preparationFacts.length ? (
            <section aria-label={tr("playback.preparationFacts")} className="playback-preparation-facts">
              <PlaybackFactList facts={preparationFacts} onOpenSource={onOpenSource} />
            </section>
          ) : null}
        </div>
      ) : session && currentStep ? (
        <div className="playback-layout">
          <article
            aria-label={`${displayKind(currentStep.node_kind)} slide: ${currentStep.title}`}
            className="playback-slide"
            style={{ "--playback-kind-color": slideMeta(currentStep.node_kind).color } as CSSProperties}
          >
            <SlideHeading
              node={node}
              onOpenSource={onOpenSource}
              stepKind={currentStep.node_kind}
              stepSummary={currentStep.summary}
              stepTitle={currentStep.title}
            />
            <PlaybackSlideContent
              dialogue={currentStep.dialogue}
              node={node}
              nodeLabels={nodeLabels}
              stepKind={currentStep.node_kind}
            />
            {latestChanges.length ? <StateChangeSummary changes={latestChanges} /> : null}
            {session.status === "ended" ? (
              <div className="playback-ending" role="status">
                <CheckCircle2 size={19} aria-hidden="true" />
                <div><strong>{session.terminal_exit ? tr("playback.exitReached", { name: session.terminal_exit.label || session.terminal_exit.key }) : tr("playback.endingReached")}</strong><span>{session.terminal_exit ? tr("playback.directExitResult", { key: session.terminal_exit.key }) : tr("playback.noFurtherTransition")}</span></div>
              </div>
            ) : null}
            {session.status === "blocked" ? (
              <PlaybackFactSummary
                facts={session.facts}
                onOpenTrace={openFactTrace}
                onOpenSource={onOpenSource}
                session={session}
                stale={stale}
              />
            ) : null}
          </article>

          <aside aria-label={tr("playback.choices")} className="playback-choice-rail">
            <div className="playback-choice-heading">
              <span>
                {session.status === "ended"
                  ? tr("playback.routeComplete")
                  : currentStep.dialogue && !currentStep.dialogue.complete
                    ? tr("playback.chooseReply")
                    : tr("playback.chooseNext")}
              </span>
              <strong>
                {tr("playback.available", {
                  count: currentStep.dialogue && !currentStep.dialogue.complete
                    ? currentStep.dialogue.options.filter((option) => option.eligible).length
                    : currentStep.choices.filter((choice) => choice.eligible).length
                })}
              </strong>
            </div>
            {currentStep.dialogue && !currentStep.dialogue.complete ? (
              <div className="playback-choice-list">
                {currentStep.dialogue.options.map((option) => (
                  <PlaybackDialogueOptionButton
                    busy={busy || session.status === "blocked"}
                    key={option.option_id}
                    onChoose={onChoose}
                    option={option}
                  />
                ))}
              </div>
            ) : currentStep.choices.length ? (
              <div className="playback-choice-list">
                {currentStep.choices.map((choice) => (
                  <PlaybackChoiceButton
                    busy={busy || session.status === "blocked"}
                    choice={choice}
                    key={choice.transition_id}
                    onChoose={onChoose}
                  />
                ))}
              </div>
            ) : (
              <p className="playback-no-choices">{tr("playback.noTransitions")}</p>
            )}
            <div aria-live="polite" className="playback-live-status">
              {busy ? tr("playback.updating") : announcement || tr("playback.ready", { title: currentStep.title })}
            </div>
          </aside>
        </div>
      ) : (
        <PlaybackStateMessage
          Icon={AlertTriangle}
          actionLabel={tr("playback.tryAgain")}
          message={tr("playback.noCurrentStep")}
          onAction={onRetry}
          title={tr("playback.stepUnavailable")}
        />
      )}
      {diagnosticsOpen && session ? (
        <PlaybackDiagnostics
          nodeLabels={nodeLabels}
          onClose={() => setDiagnosticsOpen(false)}
          onOpenSource={onOpenSource}
          onSelectTrace={setSelectedTraceSequence}
          selectedTraceRef={selectedTraceRef}
          selectedTraceSequence={selectedTraceSequence}
          session={session}
          setTab={setDiagnosticTab}
          tab={diagnosticTab}
          transitionLabels={transitionLabels}
        />
      ) : null}
    </section>
  );
}

function SlideHeading({
  node,
  onOpenSource,
  stepKind,
  stepSummary,
  stepTitle
}: {
  node: Node<NarrativeNodeData> | null;
  onOpenSource: (target: PlaybackSourceTarget) => void;
  stepKind: string;
  stepSummary: string;
  stepTitle: string;
}) {
  const { Icon } = slideMeta(stepKind);
  return (
    <header className="playback-slide-heading">
      <div className="playback-slide-source-row">
        <span><Icon size={16} aria-hidden="true" />{displayKind(stepKind)}</span>
        {node ? (
          <PlaybackSourceActions
            nodeId={node.data.canonicalNodeId ?? node.id}
            onOpenSource={onOpenSource}
          />
        ) : null}
      </div>
      <h2>{node?.data.title ?? stepTitle}</h2>
      <p>{node?.data.summary || stepSummary || "No authored description for this beat."}</p>
    </header>
  );
}

function PlaybackSourceActions({
  compact = false,
  nodeId,
  onOpenSource
}: {
  compact?: boolean;
  nodeId: string;
  onOpenSource: (target: PlaybackSourceTarget) => void;
}) {
  const actions = [
    { Icon: Share2, label: tr("workspace.graph"), mode: "relationships" as const },
    { Icon: GitBranch, label: tr("workspace.flow"), mode: "flow" as const },
    { Icon: FileText, label: tr("workspace.story"), mode: "story" as const },
    { Icon: Pencil, label: tr("common.edit"), mode: "edit" as const }
  ];
  return (
    <div aria-label={tr("playback.openSource")} className={`playback-source-actions ${compact ? "playback-source-actions-compact" : ""}`} role="group">
      {actions.map(({ Icon, label, mode }) => (
        <button
          aria-label={tr("playback.openSourceIn", { view: label })}
          key={mode}
          onClick={() => onOpenSource({ kind: "node", mode, nodeId })}
          title={tr("playback.openIn", { view: label })}
          type="button"
        >
          <Icon size={compact ? 12 : 13} aria-hidden="true" />
          {compact ? null : label}
        </button>
      ))}
    </div>
  );
}

/** Projects canonical type-specific fields without copying them into the session. */
export function PlaybackSlideContent({
  dialogue,
  node,
  nodeLabels = {},
  stepKind
}: {
  dialogue?: PlaybackDialogueStep | null;
  node: Node<NarrativeNodeData> | null;
  nodeLabels?: Record<string, string>;
  stepKind: string;
}) {
  if (!node) {
    return <div className="playback-type-content"><p>{tr("playback.canonicalUnavailable")}</p></div>;
  }
  const data = node.data;
  if (stepKind === "Dialogue") {
    return (
      <div aria-label={tr("playback.dialogueSlide")} className="playback-type-content playback-dialogue-content">
        <strong>{dialogue?.complete ? tr("playback.dialogueOutcome") : dialogue?.prompt || tr("node.dialogue")}</strong>
        {dialogue?.turns.map((turn) => "line_version" in turn ? (
          <p key={turn.element_id}>
            <span>{nodeLabels[turn.speaker_node_id] ?? turn.speaker_node_id}</span>
            {turn.text}
          </p>
        ) : (
          <p className="playback-dialogue-selection" key={`${turn.choice_element_id}:${turn.option_id}`}>
            <span>{tr("playback.yourReply")}</span>
            {turn.text}
          </p>
        )) ?? <p>{tr("playback.dialogueUnavailable")}</p>}
      </div>
    );
  }
  if (stepKind === "Quest") {
    const document = data.questDocument;
    return (
      <div aria-label={tr("playback.questSlide")} className="playback-type-content">
        <strong>{document?.objective || tr("playback.questObjectiveMissing")}</strong>
        <ol>{document?.stages.map((stage) => <li key={stage.id}><span>{stage.title}</span><small>{stage.description}</small></li>)}</ol>
      </div>
    );
  }
  if (stepKind === "Condition") {
    return (
      <div aria-label={tr("playback.requirementSlide")} className="playback-type-content">
        <strong>{data.requirement?.subject || data.title}</strong>
        <p>{data.requirement?.predicate || tr("playback.requirementMissing")}</p>
        {data.requirement?.expression ? <code>{data.requirement.expression}</code> : null}
      </div>
    );
  }
  if (stepKind === "Consequence") {
    return (
      <div aria-label={tr("playback.outcomeSlide")} className="playback-type-content">
        <strong>{data.outcome?.effect || data.summary}</strong>
        <p>{tr("playback.canonicalTargets", { count: data.outcome?.targetNodeIds.length ?? 0 })}</p>
      </div>
    );
  }
  if (stepKind === "Character") {
    return <div aria-label={tr("playback.characterSlide")} className="playback-type-content"><strong>{tr("authoring.role")}</strong><p>{data.characterRole || tr("playback.roleMissing")}</p><TagList tags={data.tags} /></div>;
  }
  if (stepKind === "Item") {
    return <div aria-label={tr("playback.itemSlide")} className="playback-type-content"><strong>{tr("playback.itemUse")}</strong><p>{data.itemPurpose || tr("playback.itemPurposeMissing")}</p><TagList tags={data.tags} /></div>;
  }
  return (
    <div aria-label={tr("playback.kindSlide", { kind: displayKind(stepKind) })} className="playback-type-content">
      <strong>{tr(stepKind === "Scene" || stepKind === "Location" ? "playback.containedSpace" : "playback.authoredBeat")}</strong>
      <TagList tags={data.tags} />
    </div>
  );
}

function PlaybackChoiceButton({
  busy,
  choice,
  onChoose
}: {
  busy: boolean;
  choice: PlaybackChoice;
  onChoose: (selection: PlaybackSelection) => void;
}) {
  const reasonId = `playback-choice-reason-${choice.transition_id}`;
  return (
    <div className={`playback-choice ${choice.eligible ? "" : "playback-choice-disabled"}`}>
      <button
        aria-describedby={!choice.eligible ? reasonId : undefined}
        disabled={!choice.eligible || busy}
        onClick={() => onChoose({ id: choice.transition_id, kind: "transition" })}
        type="button"
      >
        <span>{choice.label || "Continue"}</span>
        <small>{choice.operation === "call" ? tr("playback.callFlow") : choice.is_default ? "Default" : choice.kind}</small>
      </button>
      {!choice.eligible ? <p id={reasonId}>{choice.disabled_reason || choice.condition_result?.message || "This choice is unavailable."}</p> : null}
    </div>
  );
}

function PlaybackDialogueOptionButton({
  busy,
  onChoose,
  option
}: {
  busy: boolean;
  onChoose: (selection: PlaybackSelection) => void;
  option: PlaybackDialogueOption;
}) {
  const reasonId = `playback-dialogue-reason-${option.option_id}`;
  return (
    <div className={`playback-choice playback-dialogue-choice ${option.eligible ? "" : "playback-choice-disabled"}`}>
      <button
        aria-describedby={!option.eligible ? reasonId : undefined}
        disabled={!option.eligible || busy}
        onClick={() => onChoose({ id: option.option_id, kind: "dialogue" })}
        type="button"
      >
        <span>{option.text}</span>
        <small>{tr("playback.reply")}</small>
      </button>
      {!option.eligible ? <p id={reasonId}>{option.disabled_reason || "This reply is unavailable."}</p> : null}
    </div>
  );
}

/** Presents runtime trace and state without making either frontend-owned. */
function PlaybackDiagnostics({
  nodeLabels,
  onClose,
  onOpenSource,
  onSelectTrace,
  selectedTraceRef,
  selectedTraceSequence,
  session,
  setTab,
  tab,
  transitionLabels
}: {
  nodeLabels: Record<string, string>;
  onClose: () => void;
  onOpenSource: (target: PlaybackSourceTarget) => void;
  onSelectTrace: (sequence: number) => void;
  selectedTraceRef: { current: HTMLLIElement | null };
  selectedTraceSequence: number | null;
  session: PlaybackSession;
  setTab: (tab: "facts" | "state" | "trace") => void;
  tab: "facts" | "state" | "trace";
  transitionLabels: Record<string, string>;
}) {
  return (
    <aside aria-label={tr("playback.diagnosticsPanel")} className="playback-diagnostics">
      <header className="playback-diagnostics-header">
        <div>
          <span>{tr("playback.diagnostics")}</span>
          <strong>{tr("playback.traceSteps", { count: session.trace.length })}</strong>
        </div>
        <button aria-label={tr("playback.closeDiagnostics")} onClick={onClose} type="button">
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div aria-label={tr("playback.diagnosticView")} className="playback-diagnostic-tabs" role="tablist">
        <button
          aria-controls="playback-trace-panel"
          aria-selected={tab === "trace"}
          onClick={() => setTab("trace")}
          role="tab"
          type="button"
        >
          <ListTree size={15} aria-hidden="true" />
          {tr("playback.trace")}
        </button>
        <button
          aria-controls="playback-state-panel"
          aria-selected={tab === "state"}
          onClick={() => setTab("state")}
          role="tab"
          type="button"
        >
          <Database size={15} aria-hidden="true" />
          {tr("playback.state")}
        </button>
        <button
          aria-controls="playback-facts-panel"
          aria-selected={tab === "facts"}
          onClick={() => setTab("facts")}
          role="tab"
          type="button"
        >
          <AlertTriangle size={15} aria-hidden="true" />
          {tr("playback.facts")}
        </button>
      </div>
      {tab === "trace" ? (
        <section aria-label={tr("playback.tracePanel")} className="playback-diagnostic-content" id="playback-trace-panel" role="tabpanel">
          {session.trace.length ? (
            <ol className="playback-trace-list">
              {session.trace.map((entry) => {
                const selected = entry.sequence === selectedTraceSequence;
                return (
                  <li
                    aria-current={selected ? "step" : undefined}
                    className={selected ? "playback-trace-selected" : ""}
                    key={`${entry.sequence}:${entry.transition_id}`}
                    ref={selected ? selectedTraceRef : undefined}
                    tabIndex={selected ? -1 : undefined}
                  >
                    <button onClick={() => onSelectTrace(entry.sequence)} type="button">
                      <span>{tr("playback.step", { count: entry.sequence + 1 })}</span>
                      <strong>{nodeLabels[entry.node_id] ?? entry.node_id}</strong>
                      <small>
                        {entry.transition_id
                          ? transitionLabels[entry.transition_id] ?? entry.transition_id
                          : entry.dialogue_option_id
                            ? `Reply: ${entry.dialogue_option_id}`
                            : "Entry"}
                      </small>
                    </button>
                    <div className="playback-trace-source-actions">
                      <PlaybackSourceActions
                        compact
                        nodeId={entry.node_id}
                        onOpenSource={onOpenSource}
                      />
                      {entry.transition_id ? (
                        <button
                          onClick={() => onOpenSource({ kind: "transition", transitionId: entry.transition_id! })}
                          title={tr("playback.openTransition")}
                          type="button"
                        >
                          <GitBranch size={12} aria-hidden="true" />
                          {tr("playback.transition")}
                        </button>
                      ) : null}
                    </div>
                    {entry.condition_results.length ? (
                      <div className="playback-trace-conditions">
                        {entry.condition_results.map((result) => (
                          <p key={`${entry.sequence}:${result.expression}`}>
                            <span data-status={result.status}>{result.status}</span>
                            {result.message || result.expression}
                          </p>
                        ))}
                      </div>
                    ) : <p className="playback-trace-empty-detail">{tr("playback.noCondition")}</p>}
                    {entry.events?.length ? (
                      <div aria-label={tr("playback.composedOperations")} className="playback-trace-events">
                        {entry.events.map((event, index) => <p data-operation={event.operation} key={`${entry.sequence}:${event.operation}:${index}`}><strong>{event.operation}</strong>{event.message}</p>)}
                      </div>
                    ) : null}
                    {entry.state_changes.length ? (
                      <div className="playback-trace-changes">
                        {entry.state_changes.map((change) => (
                          <p key={change.effect_id}>
                            <strong>
                              {change.explanation}
                              <button
                                aria-label={tr("playback.openEffectNamed", { name: change.explanation })}
                                onClick={() => onOpenSource({ effectId: change.effect_id, kind: "effect" })}
                                title={tr("playback.openEffect")}
                                type="button"
                              >
                                <Pencil size={11} aria-hidden="true" />
                              </button>
                            </strong>
                            <small>{formatStateValue(change.before)} → {formatStateValue(change.after)}</small>
                          </p>
                        ))}
                      </div>
                    ) : <p className="playback-trace-empty-detail">{tr("playback.noChanges")}</p>}
                  </li>
                );
              })}
            </ol>
          ) : (
            <PlaybackDiagnosticEmpty
              message={tr("playback.noTraceHint")}
              title={tr("playback.noTrace")}
            />
          )}
        </section>
      ) : tab === "state" ? (
        <section aria-label={tr("playback.statePanel")} className="playback-diagnostic-content" id="playback-state-panel" role="tabpanel">
          <PlaybackStateInspector nodeLabels={nodeLabels} state={session.state} />
        </section>
      ) : (
        <section aria-label={tr("playback.factsPanel")} className="playback-diagnostic-content" id="playback-facts-panel" role="tabpanel">
          <PlaybackFactList facts={session.facts} onOpenSource={onOpenSource} />
        </section>
      )}
    </aside>
  );
}

function PlaybackStateInspector({
  nodeLabels,
  state
}: {
  nodeLabels: Record<string, string>;
  state: PlaybackState;
}) {
  const flagEntries = Object.entries(state.flags);
  const questEntries = Object.entries(state.quest_states);
  const dialogueEntries = Object.entries(state.dialogue_choice_ids);
  const custodyEntries = Object.entries(state.item_holders);
  return (
    <div className="playback-state-inspector">
      <StateSection
        empty={tr("playback.noFlags")}
        items={flagEntries.map(([name, value]) => ({ label: name, value: String(value) }))}
        title={tr("playback.flags")}
      />
      <StateSection
        empty={tr("playback.inventoryEmpty")}
        items={state.inventory_node_ids.map((id) => ({ label: nodeLabels[id] ?? id, value: id }))}
        title={tr("playback.inventory")}
      />
      <StateSection
        empty={tr("playback.noCustody")}
        items={custodyEntries.map(([itemId, holder]) => ({
          label: nodeLabels[itemId] ?? itemId,
          value: holder.node_id ? `${tr(`playback.holder.${holder.kind}`)}: ${nodeLabels[holder.node_id] ?? holder.node_id}` : tr(`playback.holder.${holder.kind}`)
        }))}
        title={tr("playback.custody")}
      />
      <StateSection
        empty={tr("playback.noQuestState")}
        items={questEntries.map(([id, status]) => ({ label: nodeLabels[id] ?? id, value: status }))}
        title={tr("playback.quests")}
      />
      <StateSection
        empty={tr("playback.noDialogueChoices")}
        items={dialogueEntries.flatMap(([id, choices]) =>
          choices.length
            ? choices.map((choice) => ({ label: nodeLabels[id] ?? id, value: choice }))
            : []
        )}
        title={tr("playback.dialogueChoices")}
      />
      <StateSection
        empty={tr("playback.noVisited")}
        items={state.visited_node_ids.map((id, index) => ({
          label: `${index + 1}. ${nodeLabels[id] ?? id}`,
          value: id
        }))}
        title={tr("playback.visited")}
      />
      <StateSection
        empty={tr("playback.noEffects")}
        items={state.applied_effect_ids.map((id) => ({ label: id, value: "applied" }))}
        title={tr("playback.appliedEffects")}
      />
    </div>
  );
}

function StateSection({
  empty,
  items,
  title
}: {
  empty: string;
  items: Array<{ label: string; value: string }>;
  title: string;
}) {
  return (
    <section className="playback-state-section">
      <h3>{title}<span>{items.length}</span></h3>
      {items.length ? (
        <dl>
          {items.map((item, index) => (
            <div key={`${item.label}:${item.value}:${index}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : <p>{empty}</p>}
    </section>
  );
}

function PlaybackDiagnosticEmpty({ message, title }: { message: string; title: string }) {
  return (
    <div className="playback-diagnostic-empty">
      <ListTree size={22} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function PlaybackFactList({
  facts,
  onOpenSource
}: {
  facts: PlaybackFact[];
  onOpenSource: (target: PlaybackSourceTarget) => void;
}) {
  return facts.length ? (
    <ol className="playback-fact-list">
      {facts.map((fact, index) => (
        <li data-level={fact.level} key={`${fact.code}:${fact.transition_id ?? fact.node_id}:${index}`}>
          <span>{fact.level}</span>
          <strong>{fact.code.replace(/_/g, " ")}</strong>
          <p>{fact.message}</p>
          <small>{fact.action}</small>
          {(fact.node_id || fact.transition_id || fact.effect_id || fact.flow_id) ? (
            <button onClick={() => onOpenSource({ fact, kind: "fact" })} type="button">
              <Pencil size={11} aria-hidden="true" />
              Open source
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  ) : (
    <PlaybackDiagnosticEmpty
      message={tr("playback.noFactsHint")}
      title={tr("playback.noFacts")}
    />
  );
}

function StateChangeSummary({ changes }: { changes: PlaybackStateChange[] }) {
  return (
    <section aria-label={tr("playback.latestChanges")} aria-live="polite" className="playback-state-changes">
      <span>{tr("playback.stateChanged")}</span>
      {changes.map((change) => (
        <div key={change.effect_id}>
          <strong>{change.explanation}</strong>
          <small>{change.path}: {formatStateValue(change.before)} → {formatStateValue(change.after)}</small>
        </div>
      ))}
    </section>
  );
}

function PlaybackFactSummary({
  facts,
  onOpenTrace,
  onOpenSource,
  session,
  stale
}: {
  facts: PlaybackFact[];
  onOpenTrace: (fact: PlaybackFact) => void;
  onOpenSource: (target: PlaybackSourceTarget) => void;
  session: PlaybackSession;
  stale: boolean;
}) {
  return (
    <section aria-label={tr("playback.blockedPanel")} className="playback-blocked" role="alert">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong>{tr(stale ? "playback.sourceChanged" : "playback.blocked")}</strong>
        {facts.map((fact) => {
          const traceSequence = findFactTraceSequence(fact, session);
          return (
            <div key={`${fact.code}:${fact.transition_id ?? fact.node_id}`}>
              <p>{fact.message}</p>
              {traceSequence !== null ? (
                <button onClick={() => onOpenTrace(fact)} type="button">
                  {tr("playback.viewTraceStep", { count: traceSequence + 1 })}
                </button>
              ) : null}
              {(fact.node_id || fact.transition_id || fact.effect_id || fact.flow_id) ? (
                <button onClick={() => onOpenSource({ fact, kind: "fact" })} type="button">
                  {tr("playback.openSource")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PlaybackStateMessage({
  Icon,
  actionLabel,
  busy = false,
  message,
  onAction,
  title
}: {
  Icon: LucideIcon;
  actionLabel?: string;
  busy?: boolean;
  message: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <div className="playback-state-message" role={busy ? "status" : "alert"}>
      <Icon className={busy ? "playback-spinner" : ""} size={28} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{message}</p>
      {actionLabel && onAction ? <button onClick={onAction} type="button">{actionLabel}</button> : null}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return tags.length ? <ul className="playback-tags">{tags.map((tag) => <li key={tag}>{tag}</li>)}</ul> : null;
}

function slideMeta(kind: string) {
  return SLIDE_META[kind] ?? SLIDE_META.Event!;
}

/** Resolves an owner-addressed runtime fact to the latest responsible boundary. */
export function findFactTraceSequence(
  fact: PlaybackFact,
  session: PlaybackSession | null
): number | null {
  if (!session) return null;
  if (fact.effect_id) {
    const effectOwner = session.trace.filter((entry) =>
      entry.applied_effect_ids.includes(fact.effect_id!)
      || entry.state_changes.some((change) => change.authored_effect_id === fact.effect_id)
    ).at(-1);
    if (effectOwner) return effectOwner.sequence;
  }
  if (fact.transition_id) {
    const transitionOwner = session.trace.filter((entry) => entry.transition_id === fact.transition_id).at(-1);
    if (transitionOwner) return transitionOwner.sequence;
  }
  if (fact.node_id) {
    return session.trace.filter((entry) => entry.node_id === fact.node_id).at(-1)?.sequence ?? null;
  }
  return null;
}

function displayKind(kind: string) {
  const key = `node.${kind.toLowerCase()}` as keyof typeof import("../localization/catalogs").enCatalog;
  if (i18next.exists(key)) return tr(key);
  return kind;
}

function formatStateValue(value: PlaybackStateChange["before"]) {
  if (value === null) return "unset";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "object") return value.node_id ? `${value.kind}: ${value.node_id}` : value.kind;
  return String(value);
}
