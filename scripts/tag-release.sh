#!/bin/bash
# Tag one release: run the full verification gate first, and refuse to tag on
# any failure. The tag name feeds the tag-triggered pipeline
# (.github/workflows/release.yml), so a tag created here is a promise that the
# offline suite passed on this machine.
#
# Usage: bash scripts/tag-release.sh <bridge-dsh|bridge-browser> <version> [--e2e]
#
# The gate: version/package-name consistency -> pnpm typecheck -> pnpm test
# (all offline behavioral checks). With --e2e, pnpm test:e2e is appended and
# requires a running dsh on this machine (ws://127.0.0.1:3080).
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "usage: bash scripts/tag-release.sh <bridge-dsh|bridge-browser> <version> [--e2e]" >&2
  exit 2
}

PKG="${1:-}"
VERSION="${2:-}"
WITH_E2E=0
for arg in "${@:3}"; do
  case "$arg" in
    --e2e) WITH_E2E=1 ;;
    *) usage ;;
  esac
done

case "$PKG" in
  bridge-dsh)     PKG_DIR="packages/bridge-dsh" ;;
  bridge-browser) PKG_DIR="packages/extension" ;;
  *) usage ;;
esac

[ -n "$VERSION" ] || usage

DECLARED="$(node -p "require('./$PKG_DIR/package.json').version")"
if [ "$VERSION" != "$DECLARED" ]; then
  echo "error: tag version $VERSION != $PKG_DIR/package.json version $DECLARED" >&2
  exit 1
fi
if [ "$PKG" = "bridge-browser" ]; then
  MANIFEST_VERSION="$(node -p "require('./$PKG_DIR/manifest.json').version")"
  if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
    echo "error: tag version $VERSION != $PKG_DIR/manifest.json version $MANIFEST_VERSION" >&2
    exit 1
  fi
fi
if git rev-parse "$PKG@$VERSION" >/dev/null 2>&1; then
  echo "error: tag $PKG@$VERSION already exists" >&2
  exit 1
fi

echo "== tag gate: $PKG@$VERSION =="

# The bridge's typecheck needs the dsh host framework types, which every dsh
# installation carries under ~/.dsh/profiles and this repo reaches through a
# symlink (scripts/link-dsh-types.sh). Fail with the fix instead of a bare
# "Cannot find module" deep in tsc.
if [ "$PKG" = "bridge-dsh" ] && [ ! -e "packages/bridge-dsh/node_modules/@deepseek-ai" ]; then
  echo "error: dsh host types not linked (run: bash scripts/link-dsh-types.sh)" >&2
  exit 1
fi

echo "== pnpm typecheck =="
pnpm typecheck

echo "== pnpm test (offline suite) =="
pnpm test

if [ "$WITH_E2E" -eq 1 ]; then
  echo "== pnpm test:e2e (requires a running dsh) =="
  pnpm test:e2e
fi

echo "== git tag $PKG@$VERSION =="
git tag "$PKG@$VERSION"
git push origin "$PKG@$VERSION"
echo "tagged and pushed: $PKG@$VERSION (CI will build and publish)"
