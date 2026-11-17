"""Opt-in owned TLS server; never restart or reconfigure the normal development DB."""

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess
from time import monotonic, sleep
from uuid import uuid4

import pytest
from sqlalchemy import URL, create_engine, text
from sqlalchemy.exc import SQLAlchemyError


@dataclass(frozen=True)
class TlsPostgres:
    url: URL = field(repr=False)
    root: Path
    untrusted: Path
    missing: Path


def docker(*arguments, check=True):
    result = subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=40)
    if check and result.returncode:
        # Do not include generated credentials or a whole Docker command in errors.
        raise RuntimeError("disposable TLS server setup failed")
    return result.stdout


@pytest.fixture(scope="module")
def tls_postgres(tmp_path_factory):
    if os.getenv("STT_TEST_POSTGRES_TLS") != "1":
        pytest.skip("Set STT_TEST_POSTGRES_TLS=1 for an owned Docker TLS server")
    if not shutil.which("docker") or not shutil.which("openssl"):
        pytest.fail("Docker and OpenSSL are required for the explicitly enabled TLS gate")
    directory = tmp_path_factory.mktemp("stt-tls")
    for name in ("server", "untrusted"):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
            "-keyout", str(directory / f"{name}.key"), "-out", str(directory / f"{name}.crt")],
            capture_output=True, check=True, timeout=30)
        (directory / f"{name}.key").chmod(0o600)
    name, password = "stt-tls-" + uuid4().hex, uuid4().hex
    created = False
    try:
        # Copy via Docker rather than requiring host/VM filesystem mounts. The
        # initialization process starts only after key ownership is established.
        docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432",
            "--env", "POSTGRES_USER=stt_tls", "--env", f"POSTGRES_PASSWORD={password}", "--env", "POSTGRES_DB=stt_tls",
            "--entrypoint", "sh", "postgres:17-alpine", "-c",
            "mkdir -p /tmp/stt-tls; while [ ! -f /tmp/stt-tls/ready ]; do sleep 0.1; done; "
            "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/stt-tls/server.crt -c ssl_key_file=/tmp/stt-tls/server.key")
        created = True
        for filename in ("server.crt", "server.key"):
            docker("cp", str(directory / filename), f"{name}:/tmp/stt-tls/{filename}")
        docker("exec", name, "chown", "-R", "postgres:postgres", "/tmp/stt-tls")
        docker("exec", name, "chmod", "600", "/tmp/stt-tls/server.key")
        docker("exec", name, "touch", "/tmp/stt-tls/ready")
        mapping = json.loads(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name))
        port = int(mapping["5432/tcp"][0]["HostPort"])
        url = URL.create("postgresql+psycopg", host="localhost", port=port, username="stt_tls", password=password, database="stt_tls")
        missing = directory / "missing.crt"
        engine = create_engine(url.update_query_dict({"sslmode": "require", "sslrootcert": str(missing)}), connect_args={"connect_timeout": 1})
        try:
            deadline = monotonic() + 40
            while True:
                try:
                    with engine.connect() as connection:
                        assert connection.scalar(text("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()")) is True
                    break
                except SQLAlchemyError:
                    if monotonic() >= deadline:
                        raise RuntimeError("disposable TLS server did not become ready") from None
                    sleep(0.2)
        finally:
            engine.dispose()
        yield TlsPostgres(url, directory / "server.crt", directory / "untrusted.crt", missing)
    finally:
        # This UUID name was allocated only by this fixture, never a shared server.
        if created:
            docker("rm", "--force", name)
