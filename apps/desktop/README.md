# Desktop App

Tauri desktop shell for Something To Tell Engine.

Responsibilities:

- launch or locate the local FastAPI runtime
- host the React frontend
- provide native filesystem integration for `.narrative` project folders
- package the local-first desktop application

Business logic belongs in `services/runtime`, not in the desktop shell.

## Development

```bash
pnpm desktop:dev
```

Set `STT_RUNTIME_URL` to point the frontend at a non-default local runtime.
When unset, the shell exposes `http://127.0.0.1:8719`.
