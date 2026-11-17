# Story order and flows

A flow is a playable route through part of a project. Keep one main flow for the
central story and use side flows for reusable quests or longer branches.

## Create and order a flow

1. In the project sidebar, create a Story Flow, name it and select its kind.
2. Click its name to make it current, then open **Flow**.
3. Add a first Scene or Event using a starter command, or add an existing node.
4. Use the flag action to choose the entry when necessary.
5. Use **Continue from** on a member to connect an existing or new next element.
6. Label routes and use conditions only where needed. Give routes leaving the
   same element different priorities so the intended order is unambiguous.

Direct, branching, optional and return transitions express different route
intentions. A default route has no condition and is the fallback when no other
eligible route is available. Select a transition to inspect/edit it after creation.

## Call another flow and return

1. Prepare the side flow with an entry and internal route.
2. At a terminal result without a normal next transition, create a named exit,
   for example **Success** or **Abandoned**.
3. In the main flow, use **Call a Story Flow** on the element before the detour.
4. Choose the side flow and give the call a label, condition and distinct priority.
5. In its return settings, bind each exit to the intended continuation in the main
   flow. Review every exit; an unbound result cannot return where you expect.

Use the call badge to reopen return settings. Story expands the called story at
the call site; Playback enters the side flow and returns through the chosen exit.

## When to split

Do not create a new flow for every scene. Split when a sequence has a distinct
entry/result or is reused from multiple places. An ordinary relationship between
nodes in different flows is not a call. Archive unused flows only after checking
their callers. Test branches, calls and returns with Playback before exporting.
