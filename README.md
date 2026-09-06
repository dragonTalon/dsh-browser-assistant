# dsh Browser Assistant

**English** | [中文](README.zh.md)

Let [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) read and operate the browser tab you already have open — pages become text-only structured snapshots, the model addresses elements by number, and your login state, session, and cookies stay intact.

One pnpm workspace, two halves joined by one WebSocket:

- **`packages/bridge-dsh`** — the dsh Cordis plugin, released as **`dsh-bs-plug` `0.0.2`**, that mounts `/ext/bridge` and registers 12 `browser_*` tools.
- **`packages/extension`** — the Chrome MV3 extension, released as **`dsh-br` `0.0.2`** (service worker + content script + side panel).

> DeepSeek models have no vision, so the whole pipeline is **text-only**: no screenshots are ever captured. See [docs/architecture.md](docs/architecture.md) for the full design.

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

The bridge plugin is published to [npm](https://www.npmjs.com/package/dsh-bs-plug); the Chrome extension ships as a pre-built zip on [GitHub Releases](https://github.com/dragonTalon/dsh-browser-assistant/releases). No local compilation needed.

### 1. Install the bridge plugin (from npm)

```sh
dsh plugin --profile web add -w "dsh-bs-plug@0.0.2"
```

### 2. Download the Chrome extension

```sh
gh release download dsh-br@0.0.2 --repo dragonTalon/dsh-browser-assistant
# → dsh-br-0.0.2.zip
```

### 3. Restart dsh and verify

```sh
cd ~/.dsh && dsh web
curl http://127.0.0.1:3080/ext/bridge-config
# → {"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}
```

### 4. Load the extension

Unzip `dsh-br-0.0.2.zip`, then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder. Open any `http(s)` page, click the extension icon to open the side panel, wait for **已连接 dsh**, and chat.

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
| dsh bridge plugin | `dsh-bs-plug` | `0.0.2` | `dsh-bs-plug@0.0.2` |
| Chrome extension | `dsh-br` | `0.0.2` | `dsh-br@0.0.2` |

The bridge plugin is on npm: [`dsh-bs-plug`](https://www.npmjs.com/package/dsh-bs-plug). Each tag also has a matching [GitHub Release](https://github.com/dragonTalon/dsh-browser-assistant/releases) with its built artifact, produced automatically by the tag-triggered pipeline (`.github/workflows/release.yml`):

- `dsh-bs-plug` — install from npm: `dsh plugin --profile web add -w "dsh-bs-plug@0.0.2"` (a `dsh-bs-plug-0.0.2.tgz` is also attached to its release)
- `dsh-br-0.0.2.zip` — the extension bundle; load it via `chrome://extensions` → **Load unpacked** (or submit to the Chrome Web Store)

## Repository layout

```
packages/protocol/     shared zero-dependency wire protocol (single source of truth)
packages/bridge-dsh/   dsh bridge plugin (Cordis)
packages/extension/    Chrome MV3 extension (background / content / panel)
docs/                  architecture & feature docs
```

## Docs

- [docs/architecture.md](docs/architecture.md) — overall architecture and data flow
- [docs/bridge-plugin.md](docs/bridge-plugin.md) — bridge plugin design
- [docs/extension.md](docs/extension.md) — extension design
