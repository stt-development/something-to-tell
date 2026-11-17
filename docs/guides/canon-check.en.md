# Check story consistency

Canon check finds contradictions and incomplete authored structures. Use it after
editing a story or before export. It is different from Impact Analysis, which
asks what a proposed change may affect.

## Run and inspect

1. Open **Analysis → Canon check** in the header.
2. Run the check. Local checks work without an AI provider.
3. Read an issue's explanation, affected element and recommended action.
4. Single-click to inspect another issue; double-click or **Open source** to go
   to its element. Dialogue problems are also shown near the affected branch.

An unreachable outcome usually needs a valid route to the intended result,
not just different text. A missing reference needs a real existing target.

## Correct the cause

- Edit the source manually when you know the intended story.
- **Request suggestion** offers a repair where a supported safe fix exists.
- **Explore solutions** can help with an ambiguous decision when an assistant
  is configured. Read its assumptions before choosing an alternative.

Review the proposed change, optionally analyze its impact, then approve or reject.
No suggestion is applied merely by opening it. Some issues offer navigation only:
the application cannot safely invent your intention for every problem.

## Review status is not a repair

**Acknowledge** means you reviewed the issue, not that it is fixed. **Ignore** is
an intentional exception; use the All/Ignored filter to find it again. Reopen
returns it to review. After correcting the cause, run Canon again: a fresh check
confirms resolution. Save separately once the result is right; Undo can reverse
an approved change. If the project changed during review, request a fresh result.
