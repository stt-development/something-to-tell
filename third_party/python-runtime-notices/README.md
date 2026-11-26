# Python Runtime Notice Index

Only the reviewed index is stored here. It binds package/version/platform
evidence to license-text digests and exact locked source-archive references.
Verbatim third-party texts are not checked into this directory.

Each native candidate workflow collects fresh text into
runtime-notice-evidence.json from the verified raw candidate. CI does not fetch
the historical reports referenced by this index. Preserve fresh reports during
release preparation: temporary CI artifacts are not a permanent notice archive.

To reconstruct standalone text files offline, obtain all three reports matching
third_party/runtime-notice-inputs.json and run from the repository root:

```sh
uv run python tools/assemble_runtime_notices.py --lock uv.lock \
  --receipts third_party/runtime-notice-inputs.json \
  --linux /path/linux/runtime-notice-evidence.json \
  --windows /path/windows/runtime-notice-evidence.json \
  --darwin /path/macos/runtime-notice-evidence.json \
  --output /path/to/new-generated-directory
```

The output must not exist. Text bytes, including original line endings, are
verified before writing. New reviewed inputs require updated receipts/index;
do not substitute a current report for a pinned historical report.

This is a source-only notice index, not a complete distribution notice bundle,
verified corresponding source or redistribution approval. Native/interpreter,
installer, frontend/Rust and asset review remain separate gates. No installer
upload is enabled by these files. Missing sources and declarations are explicit
in index.json; package source references do not identify embedded libraries.
