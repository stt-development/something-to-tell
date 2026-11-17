# Guidance for assistants

Assistant memory keeps short instructions you have reviewed for future requests.
It is not a saved chat. Use it for guidance such as *preserve the guard's formal
voice*, not an entire scene, secret or transcript.

## Create guidance

1. Open **Project settings → Agent memory → Create memory**.
2. Choose the intended assistant and content language.
3. Choose Project, Scene, Node, Dialogue field or Story Flow scope and find its owner.
4. Enter a short title, direct instruction and optional rationale.
5. Save the entry, then save the project when ready.

**Add memory for this context** in a request opens the same form with known
details selected. If you ask an assistant to suggest memory, read the draft and
accept explicitly; asking, retrying or rejecting does not save it.

## Check what applies

Exact element guidance is more specific than Scene/Flow guidance, which is more
specific than project guidance. Entries apply to their chosen assistant and
language; one assistant does not silently inherit another's instructions.
For a shared element, choose the Scene context rather than assuming one.

Before consenting to a remote request, inspect **Agent memory for this request**.
It shows included and omitted guidance. This does not replace the current source
text, current style, author approval or the application's safety rules.

## Repair or retire guidance

If entries conflict, edit their topics or archive an outdated entry. If an owner
no longer exists, correct the scope instead of making it project-wide by accident.
Archive stops future use; restore enables it again when valid. Copying to another
assistant creates a separately reviewed entry. Review deletion warnings, use Undo
for mistakes and save the project. Never store provider keys or private credentials.
