# Runtime Service

FastAPI local runtime for Something To Tell Engine.

Responsibilities:

- project folder creation and validation
- API validation with Pydantic
- persistence through repository interfaces
- SQLite repositories, SQLAlchemy models, and Alembic migrations
- graph patch handling and analysis services

Application services must depend on repository interfaces rather than direct
database internals.

## Development

```bash
uv run python main.py
uv run pytest services/runtime/tests
```
