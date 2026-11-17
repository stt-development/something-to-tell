# Export your story

Export produces files for another tool. Use Save for the current project and
Save As for a separate editable project copy; export is not a project backup.

## Choose the output

| Format | Intended use |
|--------|--------------|
| JSON / YAML | Structured story data for a separate workflow |
| Ink | Narrative source for an Ink-based project |
| Yarn Spinner | Narrative source for a Yarn Spinner-based project |

Executable formats support a defined set of story features. Read the preview's
diagnostics rather than assuming every project can be exported without changes.

## Preview and write

1. Open **Export** in the header beside Save.
2. Choose a format and Whole project or Selected Story Flows. Search the flow
   list if needed; called flows and needed dependencies are included.
3. For JSON/YAML choose the identifier target. Ink/Yarn use their own target.
4. Refresh preview. Review inventory, generated content and warnings/errors.
5. Fix blocking errors in their source elements, then refresh again. Missing or
   conflicting export names can be corrected in Export Identifiers.
6. Keep the suggested export folder or choose another destination.
7. Choose **Export**. If a file exists, enable replacement only after deciding
   it is safe. Read the completion result before opening the output folder.

## Before trying the output elsewhere

Export uses current working content, including unsaved edits. It does not save
your project. A shortened onscreen preview does not shorten the output file.
If the project changes, the preview expires or a write completes, refresh before
the next export. Cancel before writing if the destination or scope is wrong.
Ink/Yarn output may need support from the receiving project; a successful write
does not automatically install a game or external editor. Test branches in Playback
and check the target tool's results before distribution.
