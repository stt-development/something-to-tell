"""Collection records are bounded data, never executable specs or arbitrary reads."""
from pathlib import Path

import pytest

from services.runtime.scripts import runtime_collection_record as records


def parse(tmp_path, value, paths=None):
    toc = tmp_path / "COLLECT-00.toc"
    toc.write_text(repr(value))
    native = {"_internal/module.so", "stt-runtime"}
    return records.collection_records(toc, native, paths or native)


def test_accepts_native_and_executable_records_without_reading_source(tmp_path):
    source = str(tmp_path / "absent-input")
    links, receipt = parse(tmp_path, ([('module.so', source, 'EXTENSION'), ('stt-runtime', source, 'EXECUTABLE')],))
    assert links == {"_internal/module.so": Path(source), "stt-runtime": Path(source)}
    assert "not_semantic_transformation_proof" in receipt["relationship"]


@pytest.mark.parametrize("value", [[], ([], []), ([("only",)],), ([("x", "y", [])],)])
def test_rejects_format_drift(tmp_path, value):
    with pytest.raises(ValueError, match="record_shape"):
        parse(tmp_path, value)


@pytest.mark.parametrize("destination", ["../outside.so", "/absolute.so", "C:/absolute.dll", "a/./b.so", "a//b.so"])
def test_rejects_unsafe_destinations(tmp_path, destination):
    with pytest.raises(ValueError, match="destination_invalid"):
        parse(tmp_path, ([(destination, str(tmp_path / "input"), "BINARY")],))


def test_rejects_missing_output_and_duplicate_links(tmp_path):
    source = str(tmp_path / "input")
    with pytest.raises(ValueError, match="output_missing"):
        parse(tmp_path, ([("absent.so", source, "BINARY")],))
    with pytest.raises(ValueError, match="destination_duplicate"):
        parse(tmp_path, ([("module.so", source, "BINARY")] * 2,))


def test_aliases_and_non_native_data_are_not_source_reads(tmp_path):
    links, _ = parse(tmp_path, ([("alias.so", "module.so", "SYMLINK"), ("data", "anything", "DATA")],))
    assert links == {}


def test_rejects_relative_source_paths(tmp_path):
    with pytest.raises(ValueError, match="source_not_absolute"):
        parse(tmp_path, ([("module.so", "relative.so", "BINARY")],))


def test_literal_parser_never_executes_calls_and_enforces_size(tmp_path, monkeypatch):
    toc = tmp_path / "COLLECT-00.toc"
    sentinel = tmp_path / "must-not-exist"
    toc.write_text(f'__import__("pathlib").Path({str(sentinel)!r}).touch()')
    with pytest.raises(ValueError, match="record_invalid"):
        records.collection_records(toc, set(), set())
    assert not sentinel.exists()
    monkeypatch.setattr(records, "MAX_TOC_BYTES", 1)
    with pytest.raises(ValueError, match="record_limit"):
        records.collection_records(toc, set(), set())


def test_executable_record_binds_both_tocs_to_one_bootloader_without_reading_it(tmp_path):
    source = tmp_path / "generated-runtime"
    bootloader = tmp_path / "absent-bootloader"
    toc = tmp_path / "COLLECT-00.toc"
    value = [None] * 22
    value[0], value[20] = str(source), [("run", str(bootloader), "EXECUTABLE")]
    toc.with_name("EXE-00.toc").write_text(repr(tuple(value)))
    result = records.bootloader_record(toc, {"stt-runtime": source})
    assert result[0:2] == ("stt-runtime", bootloader)
    assert len(result[2]) == 64
    assert not bootloader.exists()
    with pytest.raises(ValueError, match="link_changed"):
        records.bootloader_record(toc, {"stt-runtime": tmp_path / "other"})


def test_executable_record_rejects_ambiguous_bootloaders_and_exec_code(tmp_path):
    toc = tmp_path / "COLLECT-00.toc"
    exe = toc.with_name("EXE-00.toc")
    output = tmp_path / "runtime"
    value = [None] * 22
    value[0], value[20] = str(output), []
    exe.write_text(repr(tuple(value)))
    with pytest.raises(ValueError, match="record_shape"):
        records.bootloader_record(toc, {"stt-runtime": output})
    exe.write_text("__import__('os').getcwd()")
    with pytest.raises(ValueError, match="record_invalid"):
        records.bootloader_record(toc, {"stt-runtime": output})
