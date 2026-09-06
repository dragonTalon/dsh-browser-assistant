#!/bin/bash
# Bundle the bridge plugin with the locally available esbuild (npm is not
# reachable in this environment). `@dsh-browser/protocol` is bundled in via
# alias; `@deepseek-ai/*` and `ws` stay external so they resolve from the dsh
# profile's own node_modules at runtime (exact runtime versions).
set -euo pipefail
ESBUILD=/Users/dragon/Documents/github/deepseek-harness/node_modules/.bin/esbuild
cd "$(dirname "$0")"
rm -rf lib
"$ESBUILD" src/index.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=lib/index.js \
  --external:@deepseek-ai/* --external:ws \
  --alias:@dsh-browser/protocol=../protocol/src/protocol.ts \
  --log-level=info
echo "bridge built -> lib/index.js"
