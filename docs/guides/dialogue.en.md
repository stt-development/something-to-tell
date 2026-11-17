# Branching dialogue

A Dialogue combines speakers, spoken lines, choices and results. Create the
participating Characters on Graph first, then create and double-click a Dialogue.

## Write the conversation

1. Find Characters in the participant search and add them to the conversation.
2. Choose **Add line**, select its **Speaker** and write the line's **Text**.
3. Add another line or **Add choice**. A choice contains a prompt and replies.
4. Give every reply readable text and choose its next conversation element or
   ending. Link the first line to the choice using its next-element control.
5. Set the intended opening element as entry. Reordering cards for readability
   does not replace explicit next-element choices.
6. Choose **Save dialogue**. Resolve validation messages beneath the affected
   elements before expecting the conversation to execute correctly.

## Connect a result to the story

For a reply such as *Please open the gate*, add an outcome pointing to an existing
Event or create an Event in the outcome editor. The result connection appears on
Graph. Use **Add to flow** to make it part of the current story's order, or choose
an existing/new side flow for a longer branch. A semantic-only outcome does not
automatically execute another story step.

## Try and revise

Play a flow containing the Dialogue. Follow its lines and choose replies. If a
reply is blocked, inspect its condition and current state instead of removing the
condition just to make it available. Return to authoring and save the Dialogue
after a correction; restart Playback to test the new version.

Reassign lines before removing a speaker used by them. Closing an editor is not
a replacement for **Save dialogue**. Style recommendations and issue messages
are available beside the relevant text or problem element.
