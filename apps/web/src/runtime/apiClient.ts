/* Compatibility facade for domain-owned runtime clients. */
import { createAnalysisRuntimeClient } from "./analysisClient";
import { createAgentMemoryRuntimeClient } from "./agentMemoryClient";
import { createEngineTagRuntimeClient } from "./engineTagClient";
import { createExportRuntimeClient } from "./exportClient";
import { createFlowRuntimeClient } from "./flowClient";
import { createGraphRuntimeClient } from "./graphClient";
import { createPlaybackRuntimeClient } from "./playbackClient";
import { createProjectRuntimeClient } from "./projectClient";
import { createProviderRuntimeClient } from "./providerClient";
import { createStyleRuntimeClient } from "./styleClient";
import { createRuntimeTransport, type RuntimeTransportOptions } from "./transport";
import type { RuntimeNarrativeStatePersistence } from "../narrative-state/contracts";
import type {
  RuntimeAnalysisPersistence,
  RuntimeAgentMemoryPersistence,
  RuntimeEngineTagPersistence,
  RuntimeExportPersistence,
  RuntimeGraphAuthoringPersistence,
  RuntimeGraphLoaderPersistence,
  RuntimePlaybackPersistence,
  RuntimeProjectClientPersistence,
  RuntimeProviderPersistence,
  RuntimeStoryFlowPersistence,
  RuntimeStylePersistence
} from "./apiTypes";

export * from "./apiTypes";
export { RuntimeApiError } from "./transport";
export * from "./projections";
export { createStyleRuntimeClient } from "./styleClient";
export { createRemoteStorageClient } from "./remoteClient";

export type RuntimeApiClient = RuntimeProviderPersistence
  & RuntimeProjectClientPersistence
  & RuntimeAnalysisPersistence
  & RuntimeGraphAuthoringPersistence
  & RuntimeGraphLoaderPersistence
  & RuntimePlaybackPersistence
  & RuntimeStoryFlowPersistence
  & RuntimeNarrativeStatePersistence
  & RuntimeStylePersistence
  & RuntimeAgentMemoryPersistence
  & RuntimeEngineTagPersistence
  & RuntimeExportPersistence;

/** Preserves the historical all-domain client while exposing domain factories internally. */
export function createRuntimeApiClient(options: RuntimeTransportOptions = {}): RuntimeApiClient {
  const transport = createRuntimeTransport(options);
  const revision = options.projectRevision ?? 0;
  return {
    ...createProviderRuntimeClient(transport),
    ...createProjectRuntimeClient(transport),
    ...createAnalysisRuntimeClient(transport),
    ...createGraphRuntimeClient(transport),
    ...createPlaybackRuntimeClient(transport),
    ...createFlowRuntimeClient(transport, revision),
    ...createStyleRuntimeClient(transport),
    ...createAgentMemoryRuntimeClient(transport),
    ...createEngineTagRuntimeClient(transport),
    ...createExportRuntimeClient(transport)
  };
}
