# Check the impact of a change

Impact Analysis helps answer *what might be affected if I modify or delete this?*
Run it before a risky edit. It previews dependencies without applying the change.

## Analyze a selection

1. Select one or more elements on Graph and choose **Analyze current selection**,
   or open **Analysis → Impact Analysis**.
2. Choose Modify or Delete intent and the direction/depth you need.
3. Run the analysis and read the grouped findings.
4. Expand a dependency path to understand why an element appears.
5. Open a finding's source when you need to inspect the actual authored content.

Selection changes update the proposed scope, not the meaning of an older result.
Run again when you want findings for the new selection.

## Interpret the result

| Finding | Meaning |
|---------|---------|
| Required | The dependent element cannot keep its present meaning without this resource |
| Conditional | A particular branch or state may be affected |
| Contextual | Related story context exists; a broken executable route is not proven |

For example, deleting a reply that gives the player a key may affect the later
gate condition and a called quest. A related Character relationship is context,
not proof that the relationship is invalid.

## Compare a proposed change

Delete confirmations and suggested fixes may offer **Analyze impact**. Inspect
that preview before deciding, then return to the original review. Closing the
preview does not delete, approve or save anything. If the project changes, rerun
analysis rather than applying from stale evidence. After a real edit, use Canon
check to validate the resulting story, not Impact as a substitute.
