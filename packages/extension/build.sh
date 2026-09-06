#!/bin/bash
# Build the extension with the locally available esbuild (npm is not
# reachable in this environment). `@dsh-browser/protocol` is bundled in via
# alias; chrome.* APIs are ambient globals.
set -euo pipefail
ESBUILD=/Users/dragon/Documents/github/deepseek-harness/node_modules/.bin/esbuild
cd "$(dirname "$0")"

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

echo "extension built -> dist/"
ls -la dist/
