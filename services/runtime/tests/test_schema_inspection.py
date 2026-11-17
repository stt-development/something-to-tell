"""Revision classification is independent of SQL, credentials and migration execution."""

import pytest

from services.runtime.stt_runtime.schema_inspection import classify_revision, SchemaInspection

HEAD = "20261022_0012"
KNOWN = {"20260527_0001", "20261022_0011", HEAD}


@pytest.mark.parametrize("revisions,complete,status,observed", [
    ([HEAD], True, "current", HEAD),
    ([HEAD], False, "partial", HEAD),
    (["20261022_0011"], False, "older", "20261022_0011"),
    (["20260527_0001"], False, "older", "20260527_0001"),
    (["20261023_0013"], False, "future", "20261023_0013"),
    (["20261022_0013"], False, "future", "20261022_0013"),
    (["20261021_0013"], False, "unknown", "20261021_0013"),
    (["20261023_0011"], False, "unknown", "20261023_0011"),
    (["20261399_0013"], False, "unknown", None),
    (["foreign-branch"], False, "unknown", None),
    (["not a valid revision"], False, "unknown", None),
    (["secret\ntext"], False, "unknown", None),
    (["a" * 129], False, "unknown", None),
    ([None], False, "unknown", None),
    ([12], False, "unknown", None),
    ([], False, "partial", None),
    ([HEAD, "20261022_0011"], False, "partial", None),
    ([HEAD, HEAD], False, "partial", None),
])
def test_revision_classification_is_conservative(revisions, complete, status, observed):
    result = classify_revision(revisions, head=HEAD, known=KNOWN, current_complete=complete)
    assert result == SchemaInspection(status, observed)


def test_recognized_ancestry_does_not_depend_on_revision_spelling():
    result = classify_revision(["trusted_branch"], head=HEAD,
        known={*KNOWN, "trusted_branch"}, current_complete=False)
    assert result == SchemaInspection("older", "trusted_branch")
