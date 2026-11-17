import { afterEach, describe, expect, it } from "vitest";
import { enCatalog, ruCatalog } from "./catalogs";
import {
  BOOT_LOCALE_KEY,
  applyProjectLocale,
  formatUiDate,
  i18next,
  localizeRuntimeError,
  localizeRuntimeText,
  readBootLocale,
  setBootLocale,
  tr
} from "./i18n";

describe("localization adapter", () => {
  afterEach(async () => {
    localStorage.removeItem(BOOT_LOCALE_KEY);
    await applyProjectLocale("en");
  });

  it("keeps complete English and Russian catalogs in key parity", () => {
    expect(Object.keys(ruCatalog).sort()).toEqual(Object.keys(enCatalog).sort());
    expect(Object.values(enCatalog).every(Boolean)).toBe(true);
    expect(Object.values(ruCatalog).every(Boolean)).toBe(true);
  });

  it("keeps the Engine product name unchanged in both interface languages", async () => {
    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      expect(tr("app.name")).toBe("Something To Tell Engine");
    }
  });

  it("names export identifiers consistently without renaming stable catalog keys or author tags", async () => {
    for (const [locale, workspace, contextual, target] of [
      ["en", "Export Identifiers", "Export ID", "Target Identifier"],
      ["ru", "Идентификаторы экспорта", "ID экспорта", "Идентификатор формата"]
    ] as const) {
      await applyProjectLocale(locale);
      expect(tr("engineTags.workspace")).toBe(workspace);
      expect(tr("engineTags.contextual")).toBe(contextual);
      expect(tr("engineTags.externalIdentifier")).toBe(target);
      expect(tr("common.tags")).toBe(locale === "en" ? "Tags" : "Теги");
      expect(tr("authoring.tags")).toBe(locale === "en" ? "Tags" : "Теги");
    }
    for (const catalog of [enCatalog, ruCatalog]) {
      expect(Object.values(catalog).filter((value) => /engine tags?/i.test(value))).toEqual([]);
    }
  });

  it("localizes every integrated authoring history command", async () => {
    const keys = [
      "createNode", "updateNode", "deleteNode", "createEdge", "updateEdge",
      "deleteEdge", "createFrame", "createPlacement", "updatePlacement",
      "updatePlacements", "removePlacement", "addFactionMember", "removeFactionMember",
      "createIssue", "updateIssue", "deleteIssue", "reconcileCanonIssues",
      "updateCanonIssueStatus", "createEngineTag",
      "updateEngineTag", "deleteEngineTag", "updateProjectSettings",
      "createStoryFlow", "bootstrapStoryFlow", "updateStoryFlow", "archiveStoryFlow",
      "deleteStoryFlow", "addFlowMember", "setFlowEntry", "removeFlowMember",
      "createFlowTransition", "updateFlowTransition", "deleteFlowTransition",
      "reorderFlowTransitions", "updateSceneBoundary", "deleteSceneBoundary",
      "continueStoryFlow", "createFlowInvocation", "updateFlowInvocation",
      "deleteFlowInvocation", "createOutcomeSideFlow", "createFlowExit",
      "updateFlowExit", "deleteFlowExit", "createFlowExitBinding",
      "updateFlowExitBinding", "deleteFlowExitBinding", "updateDialogue",
      "createDialogueTransition", "updateDialogueTransition", "updateQuest",
      "createQuestTransition", "updateQuestTransition", "updateInitialState",
      "deleteInitialState", "createEffect", "updateEffect", "deleteEffect",
      "createEffectBinding", "updateEffectBinding", "deleteEffectBinding",
      "reorderEffectBindings", "importRelationshipState", "analyzeScene",
      "createAnalysisSuggestion", "updateAnalysisSuggestion", "deleteAnalysisSuggestion",
      "acceptAnalysisSuggestion", "rejectAnalysisSuggestion",
      "acceptProgressionMigration", "rejectProgressionMigration"
    ] as const;

    // History stores stable keys rather than rendered text, so every key must
    // resolve independently in each project locale.
    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      for (const key of keys) {
        expect(tr(`history.command.${key}`)).not.toBe(`history.command.${key}`);
      }
    }
  });

  it("persists boot locale while project locale remains a temporary override", async () => {
    await setBootLocale("ru");
    expect(readBootLocale()).toBe("ru");
    expect(tr("projects.title")).toBe("Проекты");

    await applyProjectLocale("en");
    expect(i18next.language).toBe("en");
    expect(readBootLocale()).toBe("ru");
    expect(tr("projects.title")).toBe("Projects");

    await applyProjectLocale(null);
    expect(tr("projects.title")).toBe("Проекты");
  });

  it("formats dates with the effective UI locale", async () => {
    await applyProjectLocale("en");
    const english = formatUiDate("2026-07-29T12:00:00Z");
    await applyProjectLocale("ru");
    const russian = formatUiDate("2026-07-29T12:00:00Z");

    expect(english).not.toBe(russian);
  });

  it("uses locale-specific plural forms", async () => {
    await applyProjectLocale("ru");

    expect(tr("workspace.nodes", { count: 1 })).toBe("1 узел");
    expect(tr("workspace.nodes", { count: 2 })).toBe("2 узла");
    expect(tr("workspace.nodes", { count: 5 })).toBe("5 узлов");
  });

  it("explains project identity conflicts and schema upgrades in both locales", async () => {
    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      expect(localizeRuntimeError({ code: "storage_migration_identity_conflict" }))
        .toBe(tr("errors.storageMigrationIdentityConflict"));
      expect(localizeRuntimeError({ code: "storage_profile_schema_mismatch" }))
        .toBe(tr("errors.storageSchemaUpgradeRequired"));
      expect(localizeRuntimeError({ code: "project_database_migration_failed" }))
        .toBe(tr("errors.databaseUpgradeFailed"));
      for (const [code, key] of [
        ["remote_project_busy", "errors.remoteProjectBusy"],
        ["remote_writer_lost", "errors.remoteWriterLost"],
        ["remote_storage_generation_mismatch", "errors.remoteWriterLost"],
        ["remote_storage_unavailable", "errors.remoteStorageUnavailable"],
        ["remote_storage_timeout", "errors.remoteStorageTimeout"],
        ["remote_schema_busy", "errors.remoteSchemaBusy"],
        ["remote_project_not_provisioned", "errors.remoteProjectNotProvisioned"],
        ["remote_storage_version_unsupported", "errors.remoteVersionUnsupported"],
        ["remote_contract_invalid", "errors.remoteContractInvalid"],
        ["remote_storage_protocol_unsupported", "errors.remoteProtocolUnsupported"],
        ["remote_revision_stale", "errors.remoteRevisionStale"],
        ["remote_generation_mismatch", "errors.remoteGenerationMismatch"],
        ["remote_command_reused", "errors.remoteCommandReused"],
        ["remote_commit_unknown", "errors.remoteCommitUnknown"],
        ["remote_local_publication_required", "errors.remoteLocalPublicationRequired"],
        ["remote_storage_binding_required", "errors.remoteBindingRequired"],
        ["remote_tls_failed", "errors.remoteTlsFailed"],
        ["remote_auth_failed", "errors.remoteAuthFailed"],
        ["remote_admin_required", "errors.remoteAdminRequired"],
        ["remote_schema_plan_stale", "errors.remoteSchemaPlanStale"],
        ["remote_schema_plan_limit", "errors.remoteSchemaPlanLimit"],
        ["remote_schema_backup_required", "errors.remoteSchemaBackupRequired"],
        ["remote_schema_future", "errors.remoteSchemaFuture"],
        ["remote_schema_unknown", "errors.remoteSchemaUnknown"],
        ["remote_schema_partial", "errors.remoteSchemaPartial"],
        ["remote_server_version_unsupported", "errors.remoteVersionUnsupported"],
        ["remote_revision_exhausted", "errors.remoteRevisionExhausted"]
      ] as const) {
        expect(localizeRuntimeError({ code })).toBe(tr(key));
      }
    }
  });

  it("localizes Canon keys and runtime roles without leaking templates", async () => {
    await applyProjectLocale("ru");

    expect(localizeRuntimeText("canon.issue.outcome.required-reachability.message"))
      .toBe("Обязательный результат диалога или квеста недостижим в исполняемом потоке.");
    expect(localizeRuntimeText("canon.issue.outcome.required-reachability.recommendation"))
      .toContain("Создайте временный исполняемый переход");
    expect(localizeRuntimeText("impact.dependency.containmentContext", { role: "child" }))
      .toBe("Ресурс участвует в визуальном вложении в роли «дочерний элемент».");
    expect(localizeRuntimeText("impact.dependency.containmentContext"))
      .toBe("Ресурс участвует в визуальном вложении в роли «ресурс».");
    expect(localizeRuntimeText("unknown.runtime.key", {}, "Fallback text")).toBe("Fallback text");
    expect(localizeRuntimeText("canon.issue.integrity.known.message", {
      problem_key: "canon.fact.dialogue.dead_end",
      owner_type: "dialogue_element",
      owner_id: "line-1",
      field_path: "next_element_id"
    })).toContain("Ветка диалога не имеет продолжения");
  });

  it("fully localizes Impact Resolution settings in Russian", async () => {
    await applyProjectLocale("ru");

    expect([
      tr("impactResolution.settingsTitle"),
      tr("impactResolution.agentMode"),
      tr("agents.impact_resolver.settings"),
      tr("agents.impact_resolver.providerProfile"),
      tr("agents.impact_resolver.model")
    ]).toEqual([
      "Разрешение последствий",
      "Агент разрешения последствий",
      "Настройки провайдера разрешения последствий",
      "Профиль провайдера разрешения последствий",
      "Модель разрешения последствий"
    ]);
    expect(tr("impactResolution.settingsDescription")).not.toMatch(/Impact (Analysis|Resolution)/);
    expect(tr("impactResolution.remoteDisabledPolicy")).not.toMatch(/Impact (Analysis|Resolution)/);
  });

  it("localizes stable runtime codes without exposing transport message keys", async () => {
    await applyProjectLocale("ru");

    expect(localizeRuntimeError({
      code: "project_locked",
      message: "project_session.project_locked",
      parameters: {}
    })).toBe("Проект уже открыт в другом сеансе.");
    expect(localizeRuntimeError({
      code: "narrative_state_owner_missing",
      message: "narrativeState.error.narrative_state_owner_missing",
      parameters: {}
    })).toBe("Выбранная точка применения эффекта больше не существует.");
    expect(localizeRuntimeError({
      code: "canon_provider_request_invalid",
      parameters: { status_code: 400 }
    })).toContain("Провайдер отклонил выбранную модель");
    expect(localizeRuntimeError({
      code: "canon_suggestion_stale",
      parameters: {}
    })).toContain("Запросите новое предложение");
    expect(localizeRuntimeError({
      code: "canon_repair_capability_unavailable",
      parameters: {}
    })).toContain("разбор решений больше недоступен");
    expect(localizeRuntimeError({
      code: "impact_depth_invalid",
      parameters: { minimum: 1, maximum: 10 }
    })).toBe("Глубина анализа последствий должна быть от 1 до 10.");

    await applyProjectLocale("en");
    expect(localizeRuntimeError({
      code: "impact_target_limit_invalid",
      parameters: { minimum: 1, maximum: 500 }
    })).toBe("Affected-resource limit must be between 1 and 500.");
    expect(localizeRuntimeError({
      code: "impact_resolution_visual_diff_invalid",
      parameters: {}
    })).toContain("visual solution preview");

    await applyProjectLocale("ru");
    expect(localizeRuntimeError({
      code: "impact_resolution_limit_invalid",
      parameters: { field: "alternatives" }
    })).toContain("alternatives");
    expect(localizeRuntimeError({
      code: "impact_resolution_run_failed",
      parameters: {}
    })).toContain("Детерминированные результаты");
    expect(localizeRuntimeError({
      code: "style_profile_secret_forbidden",
      parameters: {}
    })).toContain("не могут содержать учетные данные");
    expect(localizeRuntimeError({
      code: "engine_tag_key_collision",
      parameters: {}
    })).toContain("уже существует");

    await applyProjectLocale("en");
    expect(localizeRuntimeError({
      code: "engine_tag_identity_stale",
      parameters: {}
    })).toBe("Export Identifier data changed. Refresh the registry and try again.");
  });

  it("covers every node kind and the primary authoring workspaces in Russian", async () => {
    await applyProjectLocale("ru");

    // This table protects the cross-cutting surfaces most likely to regress when
    // a new node control is added with a literal label.
    expect([
      "character", "condition", "consequence", "dialogue", "event", "faction",
      "item", "location", "lore", "quest", "scene"
    ].map((kind) => tr(`node.${kind}` as keyof typeof enCatalog))).toEqual([
      "Персонаж", "Требование", "Результат", "Диалог", "Событие", "Фракция",
      "Предмет", "Локация", "Факт мира", "Квест", "Сцена"
    ]);
    expect([
      tr("common.open"),
      tr("common.create"),
      tr("filters.searchGraph"),
      tr("authoring.sceneAnalysis"),
      tr("story.document"),
      tr("quest.editNamed", { name: "Тест" }),
      tr("dialogue.editNamed", { name: "Тест" })
    ]).toEqual([
      "Открыть",
      "Создать",
      "Поиск по графу",
      "Анализ сцены",
      "Документ истории",
      "Редактирование квеста: Тест",
      "Редактирование диалога: Тест"
    ]);
    expect([
      tr("narrativeState.effects"),
      tr("narrativeState.effectsTooltip"),
      tr("narrativeState.moveItem"),
      tr("narrativeState.initialHolder"),
      tr("narrativeState.temporalOverlay"),
      tr("playback.diagnostics"),
      tr("playback.custody"),
      tr("playback.openEffect")
    ]).toEqual([
      "Эффекты состояния",
      "Настроить изменения состояния в этой позиции истории",
      "Переместить предмет",
      "Начальный владелец",
      "Временное состояние выбранного шага",
      "Диагностика",
      "Владение предметами",
      "Открыть источник эффекта"
    ]);
  });

  it("localizes canon review states, rules, and actions in both languages", async () => {
    const keys = [
      "canon.workspace",
      "canon.agentAnalyzing",
      "canon.runStatus.stale",
      "canon.issueStatus.review",
      "canon.severity.critical",
      "canon.rule.condition.unresolved-path",
      "canon.issue.condition.unresolved-path.message",
      "canon.issue.condition.unresolved-path.recommendation"
    ] as const;

    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      for (const key of keys) expect(tr(key)).not.toBe(key);
    }
  });

  it("localizes deterministic Impact dependency explanations in both languages", async () => {
    await applyProjectLocale("en");
    expect(tr("impact.dependency.semanticContext", {
      relationship_type: "owns",
      endpoint: "target"
    })).toContain("does not define story order");

    await applyProjectLocale("ru");
    expect(tr("impact.dependency.canonicalPlacement")).toContain("canonical node");
    expect(tr("impact.evidence.placement", { scope_key: "scene:item" }))
      .toContain("scene:item");
    expect(tr("impact.dependency.flowReturnReachability")).toContain("возвращает");
    expect(tr("impact.dependency.dialogueOutcomeTarget")).toContain("Dialogue");
    expect(tr("impact.dependency.questBranchTarget")).toContain("Quest");
    expect(tr("impact.dependency.temporalWriterRead")).toContain("эффект");
    expect(tr("impact.dependency.playbackPreparationFact")).toContain("Playback");
    expect(tr("impact.comparison.integrity.introduced", { rule_id: "flow.return-mapping" }))
      .toContain("flow.return-mapping");
    expect(tr("impact.error.impact_run_failed")).toContain("анализ последствий");
  });

  it("localizes Style Rewriter provider controls in both languages", async () => {
    const keys = [
      "style.rewriterSettingsTitle",
      "style.rewriterAgentMode",
      "style.explicitConsentPolicy",
      "agents.style_rewriter.settings",
      "agents.style_rewriter.providerProfile",
      "agents.style_rewriter.model",
      "agents.deleteProviderImpact",
      "agents.modelUnavailable",
      "style.error.style_resolution_invalid",
      "style.error.style_target_not_found",
      "style.error.style_placement_not_found",
      "style.error.style_placement_target_mismatch",
      "style.error.style_context_unreachable",
      "style.error.style_context_scene_invalid"
    ] as const;

    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      for (const key of keys) expect(tr(key)).not.toBe(key);
    }
  });

  it("localizes every Agent Memory contract error in English and Russian", async () => {
    const codes = [
      "agent_memory_invalid",
      "agent_memory_version_unsupported",
      "agent_memory_agent_unsupported",
      "agent_memory_locale_unsupported",
      "agent_memory_scope_invalid",
      "agent_memory_duplicate",
      "agent_memory_supersession_cycle",
      "agent_memory_secret_forbidden",
      "agent_memory_control_payload_forbidden",
      "agent_memory_injection_forbidden",
      "agent_memory_oversized",
      "agent_memory_resolution_stale",
      "agent_memory_resolution_target_missing",
      "agent_memory_resolution_context_required",
      "agent_memory_resolution_context_invalid",
      "agent_memory_not_found",
      "agent_memory_delete_review_required",
      "agent_memory_delete_impact_stale",
      "agent_memory_candidate_stale",
      "agent_memory_candidate_provider_invalid",
      "agent_memory_candidate_provider_unavailable",
      "agent_memory_candidate_provider_timeout",
      "agent_memory_candidate_response_invalid",
      "agent_memory_candidate_run_capacity_reached",
      "agent_memory_candidate_run_failed",
      "agent_memory_candidate_run_active",
      "agent_memory_candidate_run_cancelled",
      "agent_memory_candidate_run_not_found",
      "agent_memory_candidate_invalid",
      "agent_memory_supersedes_missing",
      "agent_memory_supersedes_invalid"
    ] as const;

    for (const locale of ["en", "ru"] as const) {
      await applyProjectLocale(locale);
      for (const code of codes) {
        const localized = localizeRuntimeError({ code });
        expect(localized).not.toBe(code);
        expect(localized).not.toBe(tr("errors.runtimeRequestFailed"));
      }
    }
  });
});
