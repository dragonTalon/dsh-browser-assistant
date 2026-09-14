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

# Resolve markdown rendering deps (marked / dompurify), same fallback order as
# esbuild: explicit override -> workspace install (CI / pnpm install) -> local
# deepseek-harness checkout .pnpm store (offline dev machine).
if [ -n "${MARKED_ESM:-}" ]; then
  : # caller-provided
elif [ -f ./node_modules/marked/lib/marked.esm.js ]; then
  MARKED_ESM=./node_modules/marked/lib/marked.esm.js
elif [ -f /Users/dragon/Documents/github/deepseek-harness/node_modules/.pnpm/marked@16.4.2/node_modules/marked/lib/marked.esm.js ]; then
  MARKED_ESM=/Users/dragon/Documents/github/deepseek-harness/node_modules/.pnpm/marked@16.4.2/node_modules/marked/lib/marked.esm.js
else
  echo "error: marked not found (run pnpm install, or set MARKED_ESM)" >&2
  exit 1
fi

if [ -n "${DOMPURIFY_ESM:-}" ]; then
  : # caller-provided
elif [ -f ./node_modules/dompurify/dist/purify.es.mjs ]; then
  DOMPURIFY_ESM=./node_modules/dompurify/dist/purify.es.mjs
elif [ -f /Users/dragon/Documents/github/deepseek-harness/node_modules/.pnpm/dompurify@3.4.11/node_modules/dompurify/dist/purify.es.mjs ]; then
  DOMPURIFY_ESM=/Users/dragon/Documents/github/deepseek-harness/node_modules/.pnpm/dompurify@3.4.11/node_modules/dompurify/dist/purify.es.mjs
else
  echo "error: dompurify not found (run pnpm install, or set DOMPURIFY_ESM)" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/panel
ALIAS="--alias:@dsh-browser/protocol=../protocol/src/index.ts"

# Markdown 渲染依赖（仅 panel 用）：本环境无 npm registry，alias 指向本地
# deepseek-harness checkout 的 .pnpm 物理路径。换机或升级版本时需同步更新。
PANEL_MD_ALIAS="--alias:marked=$MARKED_ESM --alias:dompurify=$DOMPURIFY_ESM"

# 1. background service worker (ES module)
"$ESBUILD" src/background/index.ts --bundle --format=esm --platform=browser --target=chrome116 \
  --outfile=dist/background.js $ALIAS --log-level=warning

# 2. content script (IIFE, injected into pages)
"$ESBUILD" src/content/index.ts --bundle --format=iife --platform=browser --target=chrome116 \
  --outfile=dist/content.js $ALIAS --log-level=warning

# 3. side panel (ES module)
"$ESBUILD" src/panel/main.ts --bundle --format=esm --platform=browser --target=chrome116 \
  --outfile=dist/panel/panel.js $ALIAS $PANEL_MD_ALIAS --log-level=warning

# 4. static assets
cp manifest.json dist/manifest.json
cp panel/index.html dist/panel/index.html
mkdir -p dist/icons && cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png dist/icons/

echo "extension built -> dist/"
ls -la dist/
