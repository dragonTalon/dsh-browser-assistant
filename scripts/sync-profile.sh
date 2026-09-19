#!/bin/bash
# Sync the freshly built bridge lib into the live dsh profile's installed
# bridge-dsh copy. The profile installs `bridge-dsh@^x.y.z` as an immutable
# snapshot under ~/.dsh/profiles/<profile>/node_modules/bridge-dsh, so a
# workspace `build.sh` does NOT reach the running dsh until this copy is made
# and dsh restarts (or the plugin is reloaded).
#
# Usage: bash scripts/sync-profile.sh [profile]   # profile defaults to "web"
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${1:-web}"
TARGET_LIB="$HOME/.dsh/profiles/$PROFILE/node_modules/bridge-dsh/lib/index.js"
SOURCE_LIB="packages/bridge-dsh/lib/index.js"

if [ ! -f "$SOURCE_LIB" ]; then
  echo "error: $SOURCE_LIB missing — run: bash packages/bridge-dsh/build.sh" >&2
  exit 1
fi
if [ ! -d "$(dirname "$TARGET_LIB")" ]; then
  echo "error: installed bridge-dsh not found at $TARGET_LIB" >&2
  echo "       (profile '$PROFILE' does not have the plugin installed)" >&2
  exit 1
fi

# The profile lib may be hardlinked to the workspace build (a common dev
# setup): cp refuses to copy a file onto itself, and no copy is needed then.
if [ "$SOURCE_LIB" -ef "$TARGET_LIB" ]; then
  echo "already linked: $TARGET_LIB is the workspace build (no copy needed)"
  echo "next: restart dsh (or reload the plugin) so the new bundle is loaded"
  exit 0
fi

cp "$TARGET_LIB" "$TARGET_LIB.bak-$(date +%Y%m%d)"
cp "$SOURCE_LIB" "$TARGET_LIB"
echo "synced -> $TARGET_LIB (backup alongside)"
echo "next: restart dsh (or reload the plugin) so the new bundle is loaded"
