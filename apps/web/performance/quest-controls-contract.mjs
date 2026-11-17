export const QUEST_CONTROLS_SUITE = "long_quest_controls_v1";

/** Actual Quest DOM, not an invented capped authoring collection. */
export function observeQuestControls() {
  const editor = document.querySelector('[aria-labelledby="quest-stages-heading"]');
  const selects = [...(editor?.querySelectorAll("select[data-quest-stage-target]") ?? [])];
  return { stages: editor?.querySelectorAll("article[data-canon-owner-id]").length ?? 0,
    descriptions: editor?.querySelectorAll('textarea[id^="quest-stage-description-"]').length ?? 0,
    selectors: selects.length, options: selects.reduce((sum, select) => sum + select.options.length, 0),
    max_options: Math.max(0, ...selects.map((select) => select.options.length)) };
}

export function verifyQuestControls(value) {
  if (value.stages !== 200 || value.descriptions !== 200 || value.selectors < 200
    || value.options < value.selectors || value.options > value.selectors * 2 || value.max_options > 2) throw Error("long_quest_controls_incomplete_or_unbounded");
  return value;
}
