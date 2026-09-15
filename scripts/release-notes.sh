#!/usr/bin/env bash
#
# Compose one GitHub release body from an artifact's changelog.
#
#   scripts/release-notes.sh <bridge-dsh|bridge-browser> <version>
#
# The changelog is the single source of truth for what changed; the footer (how
# to install or load this exact version) is appended here so it can never drift
# from the tag being released.
#
# A version with no changelog section is not an error: the body still explains
# itself and points at the changelog, so a release is never published with an
# empty description. Misuse (unknown artifact, missing args) exits non-zero.
set -euo pipefail

usage='usage: scripts/release-notes.sh <bridge-dsh|bridge-browser> <version>'
artifact="${1:-}"
version="${2:-}"
if [ -z "$artifact" ] || [ -z "$version" ]; then
  echo "$usage" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="https://github.com/dragonTalon/dsh-browser-assistant"

case "$artifact" in
  bridge-dsh)
    changelog="$repo_root/packages/bridge-dsh/CHANGELOG.md"
    changelog_url="$base_url/blob/main/packages/bridge-dsh/CHANGELOG.md"
    ;;
  bridge-browser)
    changelog="$repo_root/packages/extension/CHANGELOG.md"
    changelog_url="$base_url/blob/main/packages/extension/CHANGELOG.md"
    ;;
  *)
    echo "error: unknown artifact '$artifact'" >&2
    echo "$usage" >&2
    exit 2
    ;;
esac

if [ ! -f "$changelog" ]; then
  echo "error: changelog not found: $changelog" >&2
  exit 1
fi

# The "## <version>" section: everything after that heading, up to the next
# "## " heading, with trailing whitespace and surrounding blank lines trimmed.
# The heading must match the version exactly, so "0.2.0" never picks up a
# "0.2.0-rc.1" entry (and "0.2" picks up nothing).
section="$(
  awk -v want="## $version" '
    { line = $0; sub(/[[:space:]]+$/, "", line) }
    line == want { inside = 1; next }
    inside && line ~ /^## / { exit }
    inside { print }
  ' "$changelog" |
    awk 'BEGIN { n = 0; last = 0 } { n++; buf[n] = $0 } /[^[:space:]]/ { last = n } END { for (i = 1; i <= last; i++) print buf[i] }'
)"

if [ -n "$section" ]; then
  printf '%s\n\n' "$section"
else
  printf '## %s %s\n\nNo changelog entry was found for this version. See [CHANGELOG.md](%s).\n\n' \
    "$artifact" "$version" "$changelog_url"
fi

case "$artifact" in
  bridge-dsh)
    cat <<EOF
---

Published from tag \`bridge-dsh@${version}\`.

**安装 · Install** — pin the version. A bare \`@latest\` is held back by pnpm's
\`minimumReleaseAge\` (24h default) and **silently resolves to the previous
release** instead of failing:

\`\`\`sh
dsh plugin --profile web add -w "bridge-dsh@${version}" --config.minimumReleaseAge=0
\`\`\`

**要求 · Requires** — dsh ≥ \`0.1.2-rc.1\` (the 0.1.x Typert Gateway + Connection architecture).

**完整变更 · Full changelog** — [\`packages/bridge-dsh/CHANGELOG.md\`](${changelog_url})
EOF
    ;;
  bridge-browser)
    cat <<EOF
---

Published from tag \`bridge-browser@${version}\`.

**加载 · Load** — unzip \`bridge-browser-${version}.zip\`, then open
\`chrome://extensions\` → enable **Developer mode** → **Load unpacked** → select the
unzipped folder. Open any \`http(s)\` page, click the extension icon, and wait for
「已连接 dsh」.

**要求 · Requires** — Chrome 116+, plus the \`bridge-dsh\` plugin on the dsh side.

**完整变更 · Full changelog** — [\`packages/extension/CHANGELOG.md\`](${changelog_url})
EOF
    ;;
esac
