#!/bin/bash
# Link the dsh host framework's types into the bridge package, so
# `pnpm typecheck` resolves `@deepseek-ai/*` imports without any machine
# path in the repo.
#
# The bridge is a dsh plugin: its host packages (@deepseek-ai/cordis,
# @deepseek-ai/dsh-tools, …) are not on a registry reachable from here, and
# every dsh installation carries them under ~/.dsh/profiles/node_modules.
# This script makes that location visible to TypeScript through a symlink
# INSIDE the package's node_modules — the committed code stays machine-free.
#
# Run once after checkout (and again after any `pnpm install` that prunes
# the link). `scripts/tag-release.sh` refuses to tag a bridge release when
# the link is missing.
#
# Usage: bash scripts/link-dsh-types.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="$HOME/.dsh/profiles/node_modules/@deepseek-ai"
LINK="packages/bridge-dsh/node_modules/@deepseek-ai"

if [ ! -d "$TARGET" ]; then
  echo "error: dsh profile not found at $TARGET (install dsh first)" >&2
  exit 1
fi

mkdir -p "$(dirname "$LINK")"
if [ -L "$LINK" ]; then
  echo "link already present: $LINK -> $(readlink "$LINK")"
elif [ -e "$LINK" ]; then
  echo "error: $LINK exists and is not a symlink; move it away first" >&2
  exit 1
else
  ln -s "$TARGET" "$LINK"
  echo "linked: $LINK -> $TARGET"
fi
