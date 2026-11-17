# Quests

Use a Quest for an objective with intermediate stages and possible results,
rather than putting the entire task into a description or a free-form tag.

## Define the objective

1. Create a Quest and open it by double-clicking.
2. Write its general text and **Objective**. Select a **Quest giver** when useful.
3. Use the searchable **Requirements** and **Rewards** lists to select existing
   elements. Create missing story elements on Graph before selecting them.
4. Add stages, give them names and descriptions and choose the entry stage.

## Author branches

1. Add a branch to a stage and give it a meaningful label, such as *Find the key*.
2. Set a condition when the route should require an earlier action.
3. Choose either an internal target stage or an external outcome/ending.
4. For an external result, choose an existing target or create a new node.
5. Use the outcome's Story Flow action if it should continue the executable story.
6. Choose **Save quest** and resolve messages beneath incomplete branches.

Reordering stages helps organise the editor; explicit branch targets determine
the path. Removing a stage or outcome can affect routes that refer to it, so
review the warning before confirming deletion.

## Rewards and state

Selecting an Item as a reward describes the reward. If completing a branch must
actually transfer it during Playback, add a **State effect** at that result and
choose the Item and its old/new holder. Test the transfer in Playback state.

Style assistance can help with Objective and stage descriptions. Review any
proposed text before accepting; it does not design correct branches for you.
