import { useTranslation } from "react-i18next";
import { tr } from "../../localization/i18n";
import { setGraphCardExperimentEnabled, useGraphCardExperimentEnabled, setNodeDetailExperimentEnabled, useNodeDetailExperimentEnabled, setMiniMapExperimentEnabled, useMiniMapExperimentEnabled } from "../graph/canvasRenderingExperiment";
import { VIEWPORT_CARD_PRESENTATION_ENABLED, NODE_DETAIL_PRESENTATION_ENABLED } from "../graph/CanvasNodePresentation";
import { BOUNDED_MINIMAP_ENABLED } from "../graph/CanvasMiniMap";

/** Applies immediately outside the project settings draft and Save lifecycle. */
export function CanvasRenderingExperimentControl() {
  useTranslation();
  const enabled = useGraphCardExperimentEnabled(VIEWPORT_CARD_PRESENTATION_ENABLED);
  const detailEnabled = useNodeDetailExperimentEnabled(NODE_DETAIL_PRESENTATION_ENABLED);
  const minimapEnabled = useMiniMapExperimentEnabled(BOUNDED_MINIMAP_ENABLED);
  return (
    <fieldset className="border-t border-slate-200 pt-3">
      <legend className="pr-2 text-sm font-semibold text-slate-700">{tr("canvasExperiment.deviceSettings")}</legend>
      <label className="tooltip-wrapper flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-700"
        data-tooltip={tr("canvasExperiment.description")}>
        <input checked={enabled} onChange={(event) => setGraphCardExperimentEnabled(event.target.checked)} type="checkbox" />
        {tr("canvasExperiment.graphCards")}
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-700">
        <input checked={detailEnabled} onChange={(event) => setNodeDetailExperimentEnabled(event.target.checked)} type="checkbox" />
        {tr("canvasExperiment.nodeDetail")}
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-700">
        <input checked={minimapEnabled} onChange={(event) => setMiniMapExperimentEnabled(event.target.checked)} type="checkbox" />
        {tr("canvasExperiment.minimap")}
      </label>
    </fieldset>
  );
}
