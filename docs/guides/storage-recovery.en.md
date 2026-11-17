# Storage and connection recovery

Choose local storage for independent work on this device. PostgreSQL storage is
for a configured remote database and requires a network connection.
Only one writer may own a remote project at a time.

## Choose or change storage

1. During creation, choose local storage or add/select a remote storage profile.
2. For an existing project, open **Project settings** and its storage controls.
3. Select an available profile or add one with the connection details supplied
   by your administrator. Test it before confirming migration.
4. Review the destination and confirmation carefully. Do not interrupt migration
   or retry an uncertain result without inspecting what happened.

The project still needs its local folder for opening and settings. Keep it intact.
Database upgrades and backups may require your administrator; do not remove locks,
edit project files or run database commands to bypass a warning.

## If the connection fails

1. Keep the current editor open and read the error. Unsent editor text, accepted
   working changes and your last explicit save are not necessarily the same.
2. Open the database/recovery indicator near Save or in the editor header.
3. Inspect storage. If a command's result is unknown, resolve the pending command
   before trying again; an unknown result is not proof that it failed.
4. Correct the network, credentials or ownership problem. Another writer must
   close its project normally; do not force-unlock it.
5. Review reload consent, then reconnect once. If the response is lost, check
   that reconnect result instead of launching repeated reconnects.
6. Load remote working data only when ready to replace the current workspace.
   Unsent editor drafts can be lost at this step. Closing the recovery window
   without loading lets you return to the draft.

## Leave or recover safely

Use ordinary Save and Close when the connection is healthy. If you must leave an
unavailable workspace, review **Release and close project**: it loses unsent
drafts but is not Save or Discard. Wait for confirmed cleanup; failure is not a
successful close. On a later recovery prompt, compare recovering unsaved work
with opening the last saved version. Keep separate copies of important work.
