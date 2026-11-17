import type { ImpactResourceRef } from "@something-to-tell/contracts/impact-analysis";
import type { XYPosition } from "@xyflow/react";
import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { NarrativeNodeData } from "../../types";
import { NodeContextMenu } from "../project/ProjectPanels";
import type { CanvasContextMenuState } from "../workspaceShared";

const MenuState = createContext<CanvasContextMenuState | null | undefined>(undefined);
const MenuDispatch = createContext<Dispatch<SetStateAction<CanvasContextMenuState | null>> | null>(null);

/** State and commands are separate so command-only consumers do not redraw with the menu. */
export function CanvasContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);
  return <MenuDispatch.Provider value={setMenu}><MenuState.Provider value={menu}>
    {children}
  </MenuState.Provider></MenuDispatch.Provider>;
}

export function useCanvasContextMenuDispatch() {
  const dispatch = useContext(MenuDispatch);
  if (!dispatch) throw new Error("Canvas context menu commands require their provider");
  return dispatch;
}

/** Presentation only: creation policy and analysis navigation stay with existing controllers. */
export function CanvasContextMenu({ onCreate, onAnalyze }: {
  onCreate: (kind: NarrativeNodeData["kind"], position: XYPosition) => void;
  onAnalyze: (resource: ImpactResourceRef) => void;
}) {
  useTranslation();
  const menu = useContext(MenuState);
  const setMenu = useCanvasContextMenuDispatch();
  if (menu === undefined) throw new Error("Canvas context menu requires its provider");
  if (!menu) return null;
  const resource = menu.impactResource;
  return <NodeContextMenu
    x={menu.x} y={menu.y}
    canCreate={menu.flowX !== undefined && menu.flowY !== undefined}
    onAnalyze={resource ? () => onAnalyze(resource) : undefined}
    onPick={(kind) => {
      if (menu.flowX === undefined || menu.flowY === undefined) return;
      onCreate(kind, { x: menu.flowX, y: menu.flowY });
      setMenu(null);
    }}
  />;
}
