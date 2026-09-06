<p align="center">
  <img src="packages/extension/icons/icon512.png" width="160" height="160" alt="bridge-browser logo">
</p>

<h1 align="center">dsh Browser Assistant</h1>

<p align="center">
  <b>English</b> | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/bridge-dsh"><img src="https://img.shields.io/npm/v/bridge-dsh?label=bridge-dsh" alt="npm version"></a>
  <a href="https://github.com/dragonTalon/dsh-browser-assistant/releases/tag/bridge-browser%400.0.2"><img src="https://img.shields.io/badge/bridge--browser-0.0.2-5b21b6" alt="extension version"></a>
</p>

Let [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) read and operate the browser tab you already have open — pages become text-only structured snapshots, the model addresses elements by number, and your login state, session, and cookies stay intact.

One pnpm workspace, two halves joined by one WebSocket:

- **`packages/bridge-dsh`** — the dsh Cordis plugin, released as **`bridge-dsh` `0.0.3`**, that mounts `/ext/bridge` and registers 12 `browser_*` tools.
- **`packages/extension`** — the Chrome MV3 extension, released as **`bridge-browser` `0.0.2`** (service worker + content script + side panel).

> DeepSeek models have no vision, so the whole pipeline is **text-only**: no screenshots are ever captured. See [docs/en/architecture.md](docs/en/architecture.md) for the full design.

## Capabilities

| Capability | How |
|---|---|
| Read page | `browser_snapshot` → title/URL/main text/numbered controls/forms; `delta:true` returns only changes |
| Operate | `browser_click` / `browser_type` / `browser_press` / `browser_scroll` by stable number |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` |
| Read region / wait | `browser_get_text` / `browser_wait` |
| Ask the user | dsh `ask_user_question` renders in the panel; answers flow back to the model |
| Page awareness | extension tracks the active tab and injects its URL/title into each prompt as context |

Security model: the bridge carries its own bearer token; reads are auto-allowed, state-changing actions fail closed behind a side-panel approval; passwords/card numbers are masked and never leave the page.

## Requirements

- Node.js `^22` and Corepack/pnpm
- **dsh ≥ `0.1.2-rc.1`** — the minimum supported version (the `0.1.x` Typert Gateway + Connection architecture); verified against `0.1.3-alpha.1`
- Chrome 116+

## Install

The bridge plugin is published to [npm](https://www.npmjs.com/package/bridge-dsh); the Chrome extension ships as a pre-built zip on [GitHub Releases](https://github.com/dragonTalon/dsh-browser-assistant/releases). No local compilation needed.

### 1. Install the bridge plugin (from npm)

```sh
dsh plugin --profile web add -w "bridge-dsh@latest"
```

### 2. Download the Chrome extension

```sh
gh release download bridge-browser@0.0.2 --repo dragonTalon/dsh-browser-assistant
# → bridge-browser-0.0.2.zip
```

### 3. Restart dsh and verify

```sh
cd ~/.dsh && dsh web
curl http://127.0.0.1:3080/ext/bridge-config
# → {"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}
```

### 4. Load the extension

Unzip `bridge-browser-0.0.2.zip`, then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder. Open any `http(s)` page, click the extension icon to open the side panel, wait for **已连接 dsh**, and chat.

### Build from source (optional)

```sh
pnpm install --frozen-lockfile
pnpm build
# → packages/bridge-dsh/lib/index.js  and  packages/extension/dist/
```

## Releases

The two halves are released independently:

| Artifact | Package | Version | Git tag |
|---|---|---|---|
| dsh bridge plugin | `bridge-dsh` | `0.0.3` | `bridge-dsh@0.0.3` |
| Chrome extension | `bridge-browser` | `0.0.2` | `bridge-browser@0.0.2` |

The bridge plugin is on npm: [`bridge-dsh`](https://www.npmjs.com/package/bridge-dsh). Each tag also has a matching [GitHub Release](https://github.com/dragonTalon/dsh-browser-assistant/releases) with its built artifact, produced automatically by the tag-triggered pipeline (`.github/workflows/release.yml`):

- `bridge-dsh` — install from npm: `dsh plugin --profile web add -w "bridge-dsh@latest"` (a `bridge-dsh-0.0.3.tgz` is also attached to its release)
- `bridge-browser-0.0.2.zip` — the extension bundle; load it via `chrome://extensions` → **Load unpacked** (or submit to the Chrome Web Store)

## Repository layout

```
packages/protocol/     shared zero-dependency wire protocol (single source of truth)
packages/bridge-dsh/   dsh bridge plugin (Cordis)
packages/extension/    Chrome MV3 extension (background / content / panel)
docs/en/ docs/zh/       architecture & feature docs (EN / 中文)
```

## Docs

- [docs/en/architecture.md](docs/en/architecture.md) — overall architecture and data flow
- [docs/en/bridge-plugin.md](docs/en/bridge-plugin.md) — bridge plugin design
- [docs/en/extension.md](docs/en/extension.md) — extension design
