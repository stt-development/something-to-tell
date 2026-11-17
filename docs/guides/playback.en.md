# Try your story

Playback lets you act as the reader/player and test the selected Story Flow.
Its temporary choices and state do not rewrite the authored project.

## Start and make choices

1. Select the intended flow in the project sidebar and check its entry.
2. Use the Play button in the header.
3. Read the current step and choose an available continuation.
4. In a Dialogue, follow lines and choose replies. In a Quest, try a branch.
5. When a side flow is called, follow its result and verify the return destination.

Try the less obvious branches as well as the successful route. A fallback/default
route may become available only when other route conditions are not satisfied.

## Understand an unavailable choice

Open **Diagnostics** to inspect conditions, current state and the latest changes.
A condition resolving to false means its required situation is not currently
true; it is not necessarily an application error. Check whether an earlier step
sets it and whether your chosen branch reaches that step.

If the condition is correct, take a different path or prepare the required
starting state. If it is authored incorrectly, use **Open source** to edit it.
Do not approve an unrelated fix just to unlock a route.

## Back, restart and return

- **Back** returns to the preceding test boundary and restores its state.
- **Restart** starts the route from its initial state.
- Return to the authoring workspace to edit the story; use the header's return
  action to resume Playback when available.

If authored content changed, restart rather than trusting an older run. Save
your authoring changes separately; a successful test is not a project save.
