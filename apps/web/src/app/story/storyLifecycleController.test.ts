import { expect, it, vi } from "vitest";
import { createRuntimeApiClient } from "../../runtime/apiClient";
import { useGraphStore } from "../../state/graphStore";
import { createStoryLifecycleController, type StoryLifecycleControllerContext } from "./storyLifecycleController";

it("reads current rail visibility for each worldbuilding anchor without replacing the controller", () => {
  let open = true;
  const addNodeAt = vi.fn();
  const screenToFlowPosition = vi.fn(({ x, y }) => ({ x: x / 2, y: y / 2 }));
  const store = useGraphStore.getState();
  const context: StoryLifecycleControllerContext = {
    activeProjectId: "project-test", activeProjectName: "Test", activeStoryFlow: null,
    addNodeAt, applyBootstrapNode: store.applyBootstrapNode, boundarySceneId: null,
    chooseStoryFlow: vi.fn(), chooseWorkspaceMode: vi.fn(), durableAuthoring: false,
    emptyStarterLoading: null, entryCandidateId: null, flowAuthoringSourceId: null,
    flowExitSourceId: null, flowInvocationSourceId: null, getActiveGraph: store.getActiveGraph,
    nodes: [], readProjectRailOpen: () => open, projectStoryFlows: [],
    reconcileRuntimeNode: store.reconcileRuntimeNode, runtimeAuthoringAvailable: false,
    runtimePersistence: createRuntimeApiClient(), screenToFlowPosition,
    setCompletedEmptyWorkflowProjectNames: vi.fn(), setDialog: vi.fn(),
    setEmptyStarterError: vi.fn(), setEmptyStarterLoading: vi.fn(),
    setEmptyWorkflowNotice: vi.fn(), setEmptyWorkflowProjectNames: vi.fn(),
    setFlowActionError: vi.fn(), setFlowAuthoringSourceId: vi.fn(),
    setFlowAuthoringTargetId: vi.fn(), setFlowDeleteImpact: vi.fn(),
    setFlowExitSourceId: vi.fn(), setFlowInvocationSourceId: vi.fn(),
    setFreshProjectId: vi.fn(), setSelectedInvocationId: vi.fn(),
    setStoryFlowsByProject: vi.fn(), updateWorkspacePreference: vi.fn(), visibleStoryFlows: []
  };
  const controller = createStoryLifecycleController(context);
  const draft = { kind: "Lore" as const, title: "Founding myth", summary: "World lore", tags: [] };
  for (const [visibility, x] of [[true, 344], [false, 80], [true, 344]] as const) {
    open = visibility;
    controller.createWorldbuildingNode(draft);
    expect(screenToFlowPosition).toHaveBeenLastCalledWith({ x, y: 136 });
    expect(addNodeAt).toHaveBeenLastCalledWith(draft, { x: x / 2, y: 68 });
  }
  expect(context.setDialog).toHaveBeenLastCalledWith(null);
  expect(context.chooseWorkspaceMode).toHaveBeenLastCalledWith("relationships");
  expect(context.setFreshProjectId).toHaveBeenLastCalledWith(null);
  expect(context.setEmptyStarterError).toHaveBeenLastCalledWith(null);
  expect(context.setEmptyWorkflowNotice).toHaveBeenLastCalledWith("Runtime unavailable. Working locally.");
});
