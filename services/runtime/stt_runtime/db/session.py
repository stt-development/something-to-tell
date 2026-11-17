from collections.abc import Generator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from ..core.config import RuntimeSettings, get_settings
from .sqlite_policy import enable_foreign_keys


def create_runtime_engine(settings: RuntimeSettings | None = None) -> Engine:
    runtime_settings = settings or get_settings()
    connect_args = {"check_same_thread": False} if runtime_settings.database_url.startswith("sqlite") else {}
    engine = create_engine(runtime_settings.database_url, connect_args=connect_args)
    enable_foreign_keys(engine)
    return engine


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


engine = create_runtime_engine()
SessionLocal = create_session_factory(engine)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
