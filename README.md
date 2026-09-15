<p align="center">
  <img src="packages/extension/icons/icon512.png" width="160" height="160" alt="bridge-browser icon: an orange round-faced character wearing a monocle">
</p>

<h1 align="center">dsh Browser Assistant</h1>

<p align="center">
  <b>English</b> | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/bridge-dsh"><img src="https://img.shields.io/npm/v/bridge-dsh?label=bridge-dsh" alt="npm version"></a>
  <a href="https://github.com/dragonTalon/dsh-browser-assistant/releases/tag/bridge-browser%400.1.0"><img src="https://img.shields.io/badge/bridge--browser-0.1.0-5b21b6" alt="extension version"></a>
</p>

Let [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) read and operate the browser tab you already have open — pages become text-only structured snapshots, the model addresses elements by number, and your login state, session, and cookies stay intact.

One pnpm workspace, two halves joined by one WebSocket:

- **`packages/bridge-dsh`** — the dsh Cordis plugin, released as **`bridge-dsh` `0.1.0`**, that mounts `/ext/bridge` and registers 12 `browser_*` tools.
- **`packages/extension`** — the Chrome MV3 extension, released as **`bridge-browser` `0.1.0`** (service worker + content script + side panel).

> The model tool pipeline is **text-only** — pages become structured text snapshots, tools never capture screenshots. Separately, a **user-initiated** drag-select in the panel can send a cropped region screenshot to a **vision-capable** model. See [docs/en/architecture.md](docs/en/architecture.md) for the full design.

## Capabilities

| Capability | How |
|---|---|
| Read page | `browser_snapshot` → title/URL/main text/numbered controls/forms; `delta:true` returns only changes |
| Operate | `browser_click` / `browser_type` / `browser_press` / `browser_scroll` by stable number |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` |
| Read region / wait | `browser_get_text` / `browser_wait` |
| Ask the user | dsh `ask_user_question` renders in the panel; answers flow back to the model |
| Page awareness | extension tracks the active tab and injects its URL/title into each prompt as context |
| Region capture | user drag-selects a page region → cropped screenshot + DOM element list → sent to a vision-capable model |
| Model selection | panel re-pulls `model.catalog` on connect; dropdown with capability badge (vision / text / unknown) → `session.selectModel` |

Security model: the bridge carries its own bearer token; reads are auto-allowed, state-changing actions fail closed behind a side-panel approval; passwords/card numbers are masked and never leave the page. A remote connection requires the token and relaxes none of the above.

## Requirements

- Node.js `^22` and Corepack/pnpm
- **dsh ≥ `0.1.2-rc.1`** — the minimum supported version (the `0.1.x` Typert Gateway + Connection architecture); verified against `0.1.3-alpha.1`
- Chrome 116+

## Install

The bridge plugin is published to [npm](https://www.npmjs.com/package/bridge-dsh); the Chrome extension ships as a pre-built zip on [GitHub Releases](https://github.com/dragonTalon/dsh-browser-assistant/releases). No local compilation needed.

### 1. Install the bridge plugin (from npm)

```sh
dsh plugin --profile web add -w "bridge-dsh@0.1.0" --config.minimumReleaseAge=0
```

> **Pin the version — do not use `@latest`.** Since pnpm 11, `minimumReleaseAge` defaults to `1440` minutes (1 day): a version published less than a day ago is held back, and a dist-tag like `@latest` **silently resolves to the previous version** instead of failing. `--config.minimumReleaseAge=0` lifts that wait for this one install. The bridge plugin and the extension are a versioned pair, so always install the version that matches your `bridge-browser` zip.

### 2. Download the Chrome extension

```sh
gh release download bridge-browser@0.1.0 --repo dragonTalon/dsh-browser-assistant
# → bridge-browser-0.1.0.zip
```

### 3. Restart dsh and verify

```sh
cd ~/.dsh && dsh web
curl http://127.0.0.1:3080/ext/bridge-config
# → {"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}
```

### 4. Load the extension

Unzip `bridge-browser-0.1.0.zip`, then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder. Open any `http(s)` page, click the extension icon to open the side panel, wait for **已连接 dsh**, and chat.

### 5. Remote dsh (optional)

If dsh runs on another machine, open the panel's **System config** (gear button in the status bar), enter the address (`10.0.0.7:3080` or `wss://dsh.example.com`) and the token from that machine (`cat ~/.dsh/ext-bridge-token`), then press **Test connection** before saving — it performs one isolated handshake and tells you whether the address is unreachable or the token was rejected. Leaving the address empty keeps the zero-config local discovery.

Methods pinned to loopback (`settings.*`, `credentials.*`, `host.openPath`, `host.pickDirectory`) stay unavailable over a remote connection — that is the bridge's own trust fence, not a bug in the dialog.

### Build from source (optional)

```sh
pnpm install --frozen-lockfile
pnpm build
# → packages/bridge-dsh/lib/index.js  and  packages/extension/dist/
```

Note for local development: `dsh plugin add` installs a **packed snapshot** (`~/.dsh/profiles/<profile>/node_modules/bridge-dsh/`), so rebuilding the workspace `lib/index.js` alone never reaches the running dsh. After every bridge source change:

```sh
bash packages/bridge-dsh/build.sh       # rebuild the workspace artifact
bash scripts/sync-profile.sh            # copy into the installed plugin dir (auto-backup)
# then restart dsh (or reload the plugin) so the new bundle is loaded
```

> The copy above replaces the profile's **file**, but the running dsh keeps the module it already imported. A live patch reload re-runs the plugin's `apply()` with the new config while still using the **old module**, so a source change always needs a dsh restart.

### Checks

```sh
pnpm typecheck                  # tsc --noEmit across all three packages
pnpm check:grouping             # 16 offline assertions for the sessionWorkspace contract (no dsh needed)
pnpm check:grouping:e2e         # live end-to-end: session.create over the real bridge, asserted from the Workspace registry
```

`check:grouping:e2e` needs a running dsh with `sessionWorkspace` configured. It briefly supersedes the Chrome panel's bridge connection (the bridge serves one at a time; the extension reconnects on its own) and creates a real Session on every run.

## Releases

The two halves are released independently:

| Artifact | Package | Version | Git tag |
|---|---|---|---|
| dsh bridge plugin | `bridge-dsh` | `0.1.0` | `bridge-dsh@0.1.0` |
| Chrome extension | `bridge-browser` | `0.1.0` | `bridge-browser@0.1.0` |

The bridge plugin is on npm: [`bridge-dsh`](https://www.npmjs.com/package/bridge-dsh). Each tag also has a matching [GitHub Release](https://github.com/dragonTalon/dsh-browser-assistant/releases) with its built artifact, produced automatically by the tag-triggered pipeline (`.github/workflows/release.yml`):

- `bridge-dsh` — install from npm: `dsh plugin --profile web add -w "bridge-dsh@0.1.0" --config.minimumReleaseAge=0` (a `bridge-dsh-0.1.0.tgz` is also attached to its release)
- `bridge-browser-0.1.0.zip` — the extension bundle; load it via `chrome://extensions` → **Load unpacked** (or submit to the Chrome Web Store)

## Repository layout

```
packages/protocol/     shared zero-dependency wire protocol (single source of truth)
packages/bridge-dsh/   dsh bridge plugin (Cordis)
packages/extension/    Chrome MV3 extension (background / content / panel)
docs/en/ docs/zh/       architecture & feature docs (EN / 中文)
```

## Docs

Documentation is bilingual — every page has an **EN | 中文** switcher:

- [Architecture](docs/en/architecture.md) · [中文](docs/zh/architecture.md)
- [Bridge plugin](docs/en/bridge-plugin.md) · [中文](docs/zh/bridge-plugin.md)
- [Chrome extension](docs/en/extension.md) · [中文](docs/zh/extension.md)
