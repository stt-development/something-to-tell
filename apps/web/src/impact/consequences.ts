import type { ImpactFinding, ImpactResourceRef } from "@something-to-tell/contracts/impact-analysis";
import type { StoryDocumentProjection } from "../story-flow/storyDocument";
import type { StoryFlowSnapshot } from "../story-flow/contracts";

export interface ImpactExperienceProjection {
  playbackFindings: ImpactFinding[];
  storyFindingIds: Set<string>;
}

/**
 * Aggregates authored findings into readable Story and executable Playback
 * projections without creating synthetic findings or persistent resources.
 */
export function projectImpactExperiences(
  findings: readonly ImpactFinding[],
  story: StoryDocumentProjection,
  flows: readonly StoryFlowSnapshot[]
): ImpactExperienceProjection {
  const storyNodeIds = new Set(story.sections.map((section) => section.node.data.canonicalNodeId ?? section.node.id));
  const storyFlowIds = new Set(story.sections.map((section) => section.flowId));
  const transitionIds = new Set(story.sections.flatMap((section) => section.via ? [section.via.id] : []));
  const invocationIds = new Set(story.entries.flatMap((entry) => entry.kind === "call" ? [entry.invocation.id] : []));
  const exitIds = new Set(story.entries.flatMap((entry) => entry.kind === "exit" ? [entry.flowExit.id] : []));
  const bindingIds = new Set(story.entries.flatMap((entry) => entry.kind === "exit" && entry.binding ? [entry.binding.id] : []));
  const membershipIds = new Set(flows
    .filter((flow) => storyFlowIds.has(flow.flow.id))
    .flatMap((flow) => flow.nodes.map((member) => member.id)));
  const boundaryIds = new Set(flows
    .filter((flow) => storyFlowIds.has(flow.flow.id))
    .flatMap((flow) => flow.scene_boundaries.map((boundary) => boundary.id)));

  const storyFindingIds = new Set(findings.flatMap((finding) => {
    if (finding.domain === "playback") return [];
    const resources = [finding.target, ...finding.paths.flatMap((path) => path.resources)];
    return resources.some((resource) => touchesStory(
      resource,
      storyNodeIds,
      storyFlowIds,
      transitionIds,
      invocationIds,
      exitIds,
      bindingIds,
      membershipIds,
      boundaryIds
    )) ? [finding.id] : [];
  }));

  return {
    playbackFindings: findings.filter((finding) => finding.domain === "playback"),
    storyFindingIds
  };
}

/** Matches stable runtime owners to records already present in the Story projection. */
function touchesStory(
  resource: ImpactResourceRef,
  nodeIds: Set<string>,
  flowIds: Set<string>,
  transitionIds: Set<string>,
  invocationIds: Set<string>,
  exitIds: Set<string>,
  bindingIds: Set<string>,
  membershipIds: Set<string>,
  boundaryIds: Set<string>
): boolean {
  if (resource.owner_type === "node") return nodeIds.has(resource.owner_id);
  if (resource.context_type === "node" && resource.context_id) return nodeIds.has(resource.context_id);
  if (resource.context_type === "flow" && resource.context_id && flowIds.has(resource.context_id)) return true;
  if (resource.owner_type === "flow") return flowIds.has(resource.owner_id);
  if (resource.owner_type === "flow_transition") return transitionIds.has(resource.owner_id);
  if (resource.owner_type === "flow_invocation") return invocationIds.has(resource.owner_id);
  if (resource.owner_type === "flow_exit") return exitIds.has(resource.owner_id);
  if (resource.owner_type === "flow_exit_binding") return bindingIds.has(resource.owner_id);
  if (resource.owner_type === "flow_member") return membershipIds.has(resource.owner_id);
  if (resource.owner_type === "flow_entry" || resource.owner_type === "flow_terminal") return nodeIds.has(resource.owner_id);
  if (resource.owner_type === "scene_boundary") return boundaryIds.has(resource.owner_id);
  return false;
}
