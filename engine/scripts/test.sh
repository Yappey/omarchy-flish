#!/usr/bin/env bash
# Run the engine test suite.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v odin >/dev/null 2>&1 || {
  echo "odin not found. On Arch/Omarchy: sudo pacman -S odin" >&2
  exit 1
}

odin test tests
