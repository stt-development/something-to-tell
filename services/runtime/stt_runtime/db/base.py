from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def import_model_metadata() -> None:
    from . import models  # noqa: F401
    from . import remote_ownership  # noqa: F401
