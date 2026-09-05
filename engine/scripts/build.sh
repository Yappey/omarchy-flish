#!/usr/bin/env bash
# Build the Omarchy Flish engine.
#
#   scripts/build.sh            # debug build into build/
#   scripts/build.sh release    # optimised, stripped
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-debug}"
OUT="build/omarchy-flish"
mkdir -p build

command -v odin >/dev/null 2>&1 || {
  echo "odin not found. On Arch/Omarchy: sudo pacman -S odin" >&2
  exit 1
}

case "$MODE" in
  debug)   FLAGS=(-debug) ;;
  release) FLAGS=(-o:speed -no-bounds-check) ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 2 ;;
esac

# `odin build` takes the directory of the main package, not the repo root.
odin build src -out:"$OUT" "${FLAGS[@]}"
echo "built $OUT"
