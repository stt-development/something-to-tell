"""Parse pinned PyInstaller collection records without evaluating build code."""

import ast
from hashlib import sha256
from pathlib import Path, PurePosixPath

MAX_TOC_BYTES = 2 * 1024 * 1024


def collection_records(path: Path, native_paths: set[str], all_paths: set[str]) -> tuple[dict, dict]:
    with path.open("rb") as stream:
        data = stream.read(MAX_TOC_BYTES + 1)
    if len(data) > MAX_TOC_BYTES:
        raise ValueError("native_collection_record_limit")
    try:
        toc = ast.literal_eval(data.decode("utf-8"))
    except (SyntaxError, ValueError, UnicodeError, RecursionError) as error:
        raise ValueError("native_collection_record_invalid") from error
    if not isinstance(toc, tuple) or len(toc) != 1 or not isinstance(toc[0], list):
        raise ValueError("native_collection_record_shape")
    records = {}
    for item in toc[0]:
        if not isinstance(item, tuple) or len(item) != 3:
            raise ValueError("native_collection_record_shape")
        destination, source, kind = item
        if not isinstance(kind, str):
            raise ValueError("native_collection_record_shape")
        if kind not in {"BINARY", "EXTENSION", "EXECUTABLE"}:
            continue
        if not isinstance(destination, str) or not isinstance(source, str):
            raise ValueError("native_collection_record_shape")
        destination = destination.replace("\\", "/")
        name = PurePosixPath(destination)
        if name.is_absolute() or ":" in destination or any(ord(c) < 32 for c in destination) or any(p in {"", ".", ".."} for p in destination.split("/")):
            raise ValueError("native_collection_destination_invalid")
        output = destination if kind == "EXECUTABLE" else f"_internal/{destination}"
        if output not in all_paths:
            raise ValueError("native_collection_output_missing")
        if output not in native_paths:
            continue  # Internal aliases are verified by the original manifest.
        if output in records:
            raise ValueError("native_collection_destination_duplicate")
        # Source paths are lookup keys only. The attribution collector can read
        # them only if independently allowlisted by installed-input inventories.
        if not Path(source).is_absolute():
            raise ValueError("native_collection_source_not_absolute")
        records[output] = Path(source).resolve()
    return records, {"sha256": sha256(data).hexdigest(),
                     "parser_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
                     "relationship": "builder_collection_record_not_semantic_transformation_proof"}


def bootloader_record(toc: Path, links: dict) -> tuple[str, Path, str] | None:
    """Link the recipe's generated executable to its recorded bootloader input."""
    executable = next((name for name in ("stt-runtime", "stt-runtime.exe") if name in links), None)
    if executable is None:
        return None
    with toc.with_name("EXE-00.toc").open("rb") as stream:
        data = stream.read(MAX_TOC_BYTES + 1)
    if len(data) > MAX_TOC_BYTES:
        raise ValueError("native_executable_record_limit")
    try:
        record = ast.literal_eval(data.decode("utf-8"))
    except (SyntaxError, ValueError, UnicodeError, RecursionError) as error:
        raise ValueError("native_executable_record_invalid") from error
    # Pinned PyInstaller6.22.3 EXE._GUTS: name at0, selected bootloader records at20.
    if not isinstance(record, tuple) or len(record) != 22 or not isinstance(record[0], str) or Path(record[0]).resolve() != links[executable]:
        raise ValueError("native_executable_record_link_changed")
    entries = record[20]
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], tuple) or len(entries[0]) != 3:
        raise ValueError("native_executable_record_shape")
    name, source, kind = entries[0]
    if not isinstance(name, str) or name not in {"run", "run.exe"} or kind != "EXECUTABLE" or not isinstance(source, str) or not Path(source).is_absolute():
        raise ValueError("native_executable_bootloader_invalid")
    return executable, Path(source).resolve(), sha256(data).hexdigest()
