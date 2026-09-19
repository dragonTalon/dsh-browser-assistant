#!/bin/bash
# Bundle the bridge plugin with esbuild. `@dsh-browser/protocol` is bundled in
# via alias; `@deepseek-ai/*` and `ws` stay external so they resolve from the
# dsh profile's own node_modules at runtime (exact runtime versions).
set -euo pipefail
cd "$(dirname "$0")"

# Resolve esbuild: explicit override -> workspace install (pnpm install, which
# works offline against the local store with --frozen-lockfile --offline).
if [ -n "${ESBUILD:-}" ]; then
  : # caller-provided
elif [ -x ./node_modules/.bin/esbuild ]; then
  ESBUILD=./node_modules/.bin/esbuild
else
  echo "error: esbuild not found (run pnpm install --offline, or set ESBUILD)" >&2
  exit 1
fi
rm -rf lib
"$ESBUILD" src/index.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=lib/index.js \
  --external:@deepseek-ai/* --external:ws \
  --alias:@dsh-browser/protocol=../protocol/src/index.ts \
  --log-level=info
echo "bridge built -> lib/index.js"
