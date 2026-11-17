import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction } from "react";

const LayoutContext = createContext<{
  projectRailOpen: boolean;
  setProjectRailOpen: Dispatch<SetStateAction<boolean>>;
} | null>(null);
const VisibilityReaderContext = createContext<(() => boolean) | null>(null);

/** Layout can redraw the view without invalidating workspace graph computations. */
export function ProjectRailLayoutProvider({ children }: { children: ReactNode }) {
  const [projectRailOpen, setProjectRailOpen] = useState(true);
  const committedOpen = useRef(projectRailOpen);
  // Commands must see committed geometry, not a speculative concurrent render.
  useLayoutEffect(() => { committedOpen.current = projectRailOpen; }, [projectRailOpen]);
  const readProjectRailOpen = useCallback(() => committedOpen.current, []);
  const layout = useMemo(() => ({ projectRailOpen, setProjectRailOpen }), [projectRailOpen]);
  return <VisibilityReaderContext.Provider value={readProjectRailOpen}>
    <LayoutContext.Provider value={layout}>{children}</LayoutContext.Provider>
  </VisibilityReaderContext.Provider>;
}

export function useProjectRailLayout() {
  const layout = useContext(LayoutContext);
  if (!layout) throw new Error("Project rail layout requires its provider");
  return layout;
}

/** Event-time query only; command owners must not subscribe to layout changes. */
export function useProjectRailVisibilityReader() {
  const reader = useContext(VisibilityReaderContext);
  if (!reader) throw new Error("Project rail visibility reader requires its provider");
  return reader;
}
