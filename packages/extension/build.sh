#!/bin/bash
# Build the extension with esbuild. `@dsh-browser/protocol` is bundled in via
# alias; chrome.* APIs are ambient globals.
set -euo pipefail
cd "$(dirname "$0")"

# Resolve esbuild: explicit override -> workspace install (CI / pnpm install)
# -> local deepseek-harness checkout (offline fallback on the dev machine).
if [ -n "${ESBUILD:-}" ]; then
  : # caller-provided
elif [ -x ./node_modules/.bin/esbuild ]; then
  ESBUILD=./node_modules/.bin/esbuild
elif [ -x /Users/dragon/Documents/github/deepseek-harness/node_modules/.bin/esbuild ]; then
  ESBUILD=/Users/dragon/Documents/github/deepseek-harness/node_modules/.bin/esbuild
else
  echo "error: esbuild not found (run pnpm install, or set ESBUILD)" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/panel
ALIAS="--alias:@dsh-browser/protocol=../protocol/src/protocol.ts"

# 1. background service worker (ES module)
"$ESBUILD" src/background/index.ts --bundle --format=esm --platform=browser --target=chrome116 \
  --outfile=dist/background.js $ALIAS --log-level=warning

# 2. content script (IIFE, injected into pages)
"$ESBUILD" src/content/index.ts --bundle --format=iife --platform=browser --target=chrome116 \
  --outfile=dist/content.js $ALIAS --log-level=warning

# 3. side panel (ES module)
"$ESBUILD" src/panel/main.ts --bundle --format=esm --platform=browser --target=chrome116 \
  --outfile=dist/panel/panel.js $ALIAS --log-level=warning

# 4. static assets
cp manifest.json dist/manifest.json
cp panel/index.html dist/panel/index.html
mkdir -p dist/icons && cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png dist/icons/

echo "extension built -> dist/"
ls -la dist/
