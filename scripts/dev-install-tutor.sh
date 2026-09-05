#!/usr/bin/env bash
# Install the tutor plugin into the running Omarchy shell for development.
#
# Omarchy refuses symlinks anywhere inside a plugin folder, so this copies.
# Re-run it after editing tutor/ -- the shell reloads plugin code on write.
set -euo pipefail

cd "$(dirname "$0")/.."

PLUGIN_ID="flish.tutor"
DEST="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

command -v omarchy-plugin-validate >/dev/null 2>&1 \
  || { echo "omarchy-plugin-validate not found; is this Omarchy 4?" >&2; exit 1; }

omarchy-plugin-validate tutor

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r tutor/. "$DEST/"
echo "installed $PLUGIN_ID -> $DEST"

# A third-party service/panel plugin is only loaded once its id appears in
# shell.json's plugins[].
SHELL_JSON="$HOME/.config/omarchy/shell.json"
if [ -f "$SHELL_JSON" ] && ! grep -q "\"$PLUGIN_ID\"" "$SHELL_JSON"; then
  cat <<'NOTE'

Not enabled yet. Add it to ~/.config/omarchy/shell.json:

  "plugins": [{ "id": "flish.tutor" }]

then: omarchy restart shell
NOTE
fi
