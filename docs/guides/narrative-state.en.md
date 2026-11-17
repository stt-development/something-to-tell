# Conditions and effects

State records what has changed along the current route: a gate opening, an item
moving to another holder or a quest finishing. A relationship describes a fact
about the world; it does not execute a state change on its own.

## Set the starting situation

For an Item initially held by a Character, select their ownership relationship
on Graph. In **Initial holder**, choose the Story Flow, preview the proposed
Item/holder and confirm. Check that the starting owner is the one you intend.

## Add a change at the right step

1. Open the node, transition, Dialogue reply, Quest result or Flow exit where the
   change should happen.
2. Expand **State effects** and choose the action. For a transfer, use **Move item**.
3. Select the Item, **From holder** and **To holder**.
4. Add a readable explanation and choose **Add effect**.
5. If several effects happen there, order them with **Run earlier** / **Run later**.

For example, a guard agrees to help in Dialogue, then gives the key to the player.
Put the transfer on that reply/result, not on the opening conversation line.

## Require an earlier result

Give the later route a condition that checks the state you need. A condition
controls availability; it does not perform the action. An Item listed as a
reward or connected by an ownership edge is not automatically transferred.

## Test a blocked action

Open Playback **Diagnostics**, then **State** or **Facts**. Compare expected and
actual values. A transfer expecting the wrong previous holder is blocked; fix
the earlier transfer, its order or the expected holder in the authoring editor.
Use **Open source** where offered. After editing, restart Playback to retest.
Back restores the earlier test state; Restart returns to the initial situation.
