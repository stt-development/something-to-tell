from sqlalchemy import text

from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.db.session import create_runtime_engine, create_session_factory


def test_sqlalchemy_session_factory_uses_explicit_engine() -> None:
    settings = RuntimeSettings(database_url="sqlite:///:memory:")
    engine = create_runtime_engine(settings)
    session_factory = create_session_factory(engine)

    with session_factory() as session:
        result = session.execute(text("select 1")).scalar_one()

    assert result == 1
