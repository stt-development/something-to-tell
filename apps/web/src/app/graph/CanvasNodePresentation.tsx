import { useStore } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { NarrativeNodeRenderData } from "../workspaceShared";
import { projectViewportPlacements, protectedViewportPlacements } from "./nodePresentationGeometry";
import { createNodePresentationStore, FULL_NODE_PRESENTATION } from "./nodePresentationStore";
import type { ViewportScope } from "./viewportEligibility";
import { createViewportEligibilityScheduler, type ViewportEligibilityScheduler } from "./viewportEligibilityScheduler";
import { useGraphCardExperimentEnabled, useNodeDetailExperimentEnabled } from "./canvasRenderingExperiment";

// Approved Graph-only default; an explicit device Off remains authoritative.
export const VIEWPORT_CARD_PRESENTATION_ENABLED = true;
// Accepted c3 Graph detail gate; explicit device Off remains authoritative.
export const NODE_DETAIL_PRESENTATION_ENABLED = true;
interface PresentationOwner { store: ReturnType<typeof createNodePresentationStore>; spatialEnabled: boolean; detailEnabled: boolean; workspaceMode: ViewportScope["workspaceMode"] }
const PresentationContext = createContext<PresentationOwner | null>(null);

export function CanvasNodePresentation({ children, enabled, detailEnabled, workspaceMode = "relationships" }: {
  children: ReactNode; enabled?: boolean; detailEnabled?: boolean; workspaceMode?: ViewportScope["workspaceMode"];
}) {
  const experimentEnabled = useGraphCardExperimentEnabled(VIEWPORT_CARD_PRESENTATION_ENABLED);
  const active = enabled ?? (workspaceMode === "relationships" && experimentEnabled);
  const detailPreference = useNodeDetailExperimentEnabled(NODE_DETAIL_PRESENTATION_ENABLED);
  const detailActive = detailEnabled ?? (workspaceMode === "relationships" && detailPreference);
  const [store] = useState(createNodePresentationStore);
  const owner = useMemo(() => ({ store, spatialEnabled: active, detailEnabled: detailActive, workspaceMode }), [store, active, detailActive, workspaceMode]);
  useLayoutEffect(() => { store.configure(owner); }, [store, owner]);
  return <PresentationContext.Provider value={active || detailActive ? owner : null}>{children}</PresentationContext.Provider>;
}

const full = () => true;
const noopSubscription = () => () => {};

/** Experimental aggregate consumer reuses the existing spatial owner; Graph Off and Flow stay full. */
export function useNodeDomPresentationReader() {
  const owner = useContext(PresentationContext);
  return owner?.spatialEnabled && owner.workspaceMode === "relationships" ? owner.store.reader : null;
}

/** Narrow boolean subscription: mask Set replacement cannot invalidate every card. */
export function useFullNodePresentation(id: string): boolean {
  const store = useContext(PresentationContext)?.store.reader;
  const subscribe = useCallback((listener: () => void) => store?.subscribe(id, listener) ?? noopSubscription(), [id, store]);
  const snapshot = useCallback(() => store?.isFull(id) ?? true, [id, store]);
  return useSyncExternalStore(subscribe, snapshot, full);
}

export function useNodeDetailPresentation(id: string) {
  const store = useContext(PresentationContext)?.store;
  const subscribe = useCallback((listener: () => void) => store?.reader.subscribe(id, listener) ?? noopSubscription(), [id, store]);
  const snapshot = useCallback(() => store?.reader.getPresentation(id) ?? FULL_NODE_PRESENTATION, [id, store]);
  const presentation = useSyncExternalStore(subscribe, snapshot, () => FULL_NODE_PRESENTATION);
  const reveal = useCallback(() => store?.reveal(id), [id, store]);
  return { presentation, reveal };
}

export interface CanvasNodePresentationInputs {
  nodes: readonly Node<NarrativeNodeRenderData>[];
  scope: ViewportScope;
  resetKey: unknown;
  protectedOwnerIds: readonly (string | null | undefined)[];
  edges?: readonly Pick<Edge, "id" | "source" | "target" | "selected">[];
  protectedEdgeIds?: readonly (string | null | undefined)[];
}

/** The disabled release gate creates no camera subscriptions or scheduled work. */
export function CanvasNodePresentationBridge(props: CanvasNodePresentationInputs) {
  const owner = useContext(PresentationContext);
  return owner ? <CommittedPresentationBridge {...props} {...owner} /> : null;
}

function CommittedPresentationBridge({ nodes, scope, resetKey, protectedOwnerIds, edges, protectedEdgeIds, store, spatialEnabled, detailEnabled }: CanvasNodePresentationInputs & PresentationOwner) {
  // Public React Flow selectors only; the App/canvas props do not subscribe to pan.
  const transform = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const placements = useMemo(() => projectViewportPlacements(nodes), [nodes]);
  const protectedIds = useMemo(() => protectedViewportPlacements(nodes, protectedOwnerIds, edges, protectedEdgeIds), [nodes, protectedOwnerIds, edges, protectedEdgeIds]);
  const scheduler = useRef<ViewportEligibilityScheduler | null>(null);

  useLayoutEffect(() => {
    // Evaluations also settle new geometry when membership itself did not change.
    const controller = createViewportEligibilityScheduler((value) => { if (!value) store.publish(null); }, undefined, store.publish);
    scheduler.current = controller;
    return () => { scheduler.current = null; controller.dispose(); store.commit(null); };
  }, [store]);

  useLayoutEffect(() => {
    const inputs = { scope, resetKey, placements, protectedIds,
      viewport: { x: transform[0], y: transform[1], zoom: transform[2], width, height } };
    store.commit(inputs);
    scheduler.current?.update(inputs);
  }, [scope.projectId, scope.workspaceMode, scope.flowId, scope.focusedFrameId, resetKey, placements, protectedIds, transform, width, height, store, spatialEnabled, detailEnabled]);
  return null;
}
