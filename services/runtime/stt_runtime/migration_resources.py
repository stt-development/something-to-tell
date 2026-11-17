"""Read-only Alembic resources shared by local and remote storage adapters."""

from importlib.resources import files
from pathlib import Path

from alembic.config import Config


def migration_config(database_url: str | None = None) -> Config:
    """Resolve an installed/source one-directory package, never the launch CWD.

    Frozen builds must include services/runtime/alembic.ini and migrations at
    their package-relative paths. Do not extract missing resources into a user
    project or silently fall back to another checkout's migration chain.
    """
    root = files("services.runtime")
    if not isinstance(root, Path):
        raise RuntimeError("runtime_migration_resources_unavailable")
    configuration = root / "alembic.ini"
    scripts = root / "migrations"
    if not (configuration.is_file() and (scripts / "env.py").is_file()
            and (scripts / "versions").is_dir()
            and any((scripts / "versions").glob("*.py"))):
        raise RuntimeError("runtime_migration_resources_unavailable")
    config = Config(str(configuration))
    # ConfigParser interpolation must not interpret percent signs in paths/URLs.
    # Alembic injects its own unescaped 'here' default when it loads the INI.
    config.file_config.set("DEFAULT", "here", str(root).replace("%", "%%"))
    config.set_main_option("script_location", str(scripts).replace("%", "%%"))
    # The runtime is already imported; a launch directory is not an import root.
    config.set_main_option("prepend_sys_path", "")
    if database_url is not None:
        config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return config
