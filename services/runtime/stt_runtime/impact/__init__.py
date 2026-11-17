"""Deterministic Phase 5 dependency projection and traversal boundary."""

from .comparison import (
    ImpactDependencyChange,
    ImpactIntegrityChange,
    ImpactPatchComparator,
    ImpactPatchComparisonError,
    ImpactPatchComparisonResult,
    ImpactSelectionAssessment,
    ImpactSelectionInspector,
)
from .coordinator import ImpactRunCoordinator, ImpactRunCoordinatorError
from .context import (
    ImpactContextBuilderError,
    ImpactResolutionContextBuilder,
)
from .resolution_agent import (
    ImpactResolutionAgentError,
    ImpactResolutionAgentResponse,
    ImpactResolutionAgentService,
    validate_explanation_citations,
)
from .resolution_coordinator import (
    ImpactResolutionCoordinator,
    ImpactResolutionCoordinatorError,
)
from .solution_validation import (
    ImpactSolutionValidationCancelled,
    ImpactSolutionValidationResult,
    ImpactSolutionValidator,
)
from .index import ImpactDependencyIndex
from .projection import (
    GraphCompositionCanonDependencyProjector,
    ProjectDependencyProjector,
)
from .traversal import (
    ImpactDependencyTraversal,
    ImpactTraversalResult,
)

__all__ = [
    "GraphCompositionCanonDependencyProjector",
    "ImpactDependencyChange",
    "ImpactDependencyIndex",
    "ImpactDependencyTraversal",
    "ImpactContextBuilderError",
    "ImpactIntegrityChange",
    "ImpactPatchComparator",
    "ImpactPatchComparisonError",
    "ImpactPatchComparisonResult",
    "ImpactRunCoordinator",
    "ImpactRunCoordinatorError",
    "ImpactResolutionContextBuilder",
    "ImpactResolutionAgentError",
    "ImpactResolutionAgentResponse",
    "ImpactResolutionAgentService",
    "ImpactResolutionCoordinator",
    "ImpactResolutionCoordinatorError",
    "ImpactSolutionValidationCancelled",
    "ImpactSolutionValidationResult",
    "ImpactSolutionValidator",
    "ImpactSelectionAssessment",
    "ImpactSelectionInspector",
    "ImpactTraversalResult",
    "ProjectDependencyProjector",
    "validate_explanation_citations",
]
