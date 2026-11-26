#!/bin/bash
# Mounted runtime checks can briefly leave the volume busy after process exit.
# Retry only macOS EBUSY; never force-unmount or hide a persistent failure.
set -eu
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf 'Usage: bash tools/detach-macos-image.sh MOUNTPOINT\n' >&2
  exit 2
fi
for attempt in 1 2 3 4 5; do
  if hdiutil detach "$1"; then
    exit 0
  else
    status=$?
  fi
  if [ "$status" -ne 16 ] || [ "$attempt" -eq 5 ]; then
    exit "$status"
  fi
  printf 'DMG is busy; retrying detach (%s/5).\n' "$attempt" >&2
  sleep "$attempt"
done
