> [English](../en/bridge-plugin.md) | [中文](../zh/bridge-plugin.md)

# dsh bridge plugin (packages/bridge-dsh)

A **Cordis plugin** that runs inside the dsh process. It does not modify dsh core and only takes effect when present in the profile's bundle list (opt-in). It does two things: **mount a WebSocket bridge** + **register `browser_*` tools**.

## Module responsibilities

| File | Responsibility |
|---|---|
| `index.ts` | plugin entry: declares `inject`, resolves config, registers routes/tools, dsh version probe |
| `protocol.ts` → `@dsh-browser/protocol` | frame types + parsers (shared with the extension, single source of truth) |
| `server.ts` | WebSocket server: auth, single connection, RPC passthrough, tool dispatch, event pump |
| `remote-host-api.ts` | **Host adapter**: wraps Typert Gateway + Connection into `BrowserHostApi` |
| `host-api.ts` | narrow interface `BrowserHostApi` (call/events/respond), isolates dsh version differences |
| `tools.ts` | 12 `browser_*` tool definitions (the model-facing contract) |
| `token.ts` | bearer token generate/persist/constant-time compare |
| `extension-sessions.ts` | records extension-created sessions; decides who answers `ask_user_question` |
| `cordis.patch.yml` | patch applied when registering into a profile (`insert` this plugin + defaults) |

## Interface with dsh

The plugin declares `inject = ['webServer', 'typertGateway', 'connection', 'tools']` and depends only on these four services:

- `webServer`: `registerUpgrade` (mount `/ext/bridge`) + `register` (mount `/ext/bridge-config`) + `port`
- `typertGateway`: `invoke` (unary calls) + `wireStream.open` (long streams: `session/follow`, `$events`)
- `connection`: `createSharedFetchHandler('/api')` (return `$events/result` replies)
- `tools`: `ctx.tools.register` (register model-callable tools)

`remote-host-api.ts` converges these into `BrowserHostApi`, so dsh version evolution only changes this one adapter — the bridge server and the extension are unaffected.

## Core mechanisms

| Mechanism | Implementation |
|---|---|
| **Auth** | the route sits outside the `/api` trust fence and carries its own bearer token: the first `hello` frame must carry the right token within 5s (constant-time compare); failure closes the connection |
| **Loopback passwordless** | loopback connections skip the token but require a `chrome-extension://` Origin (pages cannot forge this header); non-loopback must carry the token |
| **Privilege isolation** | `settings.*`/`credentials.*`/`host.open*` etc. are rejected for non-loopback sources **even with a token** (defends `--host 0.0.0.0` deployments) |
| **Single connection** | only one extension connection at a time; a new connection supersedes the old one (old socket gets 4000, in-flight tools settle as `bridge-closed`) |
| **RPC passthrough** | the extension's `rpc` frames are routed to the gateway by method name; `session.prompt`/`session.cancel` are serialized per session to preserve order |
| **Tool dispatch** | `tool.call` frames carry `expiresAt`; timeout/cancel sends `tool.cancel` to revoke; results are normalized to `{text}` via `tool.result` |
| **Event pump** | opens the `$events` stream on connect; opens `session/follow` for that session on the first `session.prompt`, turning incremental events into `event` frames |
| **Generation resubscription** | on reconnect a new event generation re-opens the latest session's `session/follow`; events missed during the disconnect are backfilled from snapshots via a cross-generation seq cursor (queued before any `session.history` reply, naturally deduped against panel re-render); recovery failure degrades silently without dragging down the new connection |
| **Question forwarding** | the `user-questions/request` waterfall in `$events` is forwarded as `question/requested` if it belongs to an extension session, otherwise `next()` hands it to dsh's native UI |

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | string | auto-generated | fixed bearer token; when absent, generated on first boot and persisted to `~/.dsh/ext-bridge-token` (0600) |
| `toolTimeoutMs` | number | 90000 | per-tool-call budget (covers the extension's 60s approval window) |
| `snapshotMaxChars` | number | 32000 | max characters per snapshot (min 500, negotiated to the extension via `hello.ok`) |
| `maxInteractiveItems` | number | 60 | max interactive inventory items per snapshot |

## Tool list

| Tool | Purpose |
|---|---|
| `browser_snapshot` | structured text snapshot (title/URL/body/numbered inventory/forms); `delta:true` returns only changes |
| `browser_click` / `browser_type` / `browser_press` | click / type (React/Vue compatible) / key press by stable number |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` | scroll / navigate / new tab |
| `browser_back` / `browser_forward` / `browser_reload` | history back/forward / reload |
| `browser_get_text` / `browser_wait` | read a region's text / wait for the page to settle |

Every tool produces a single `{text}`; `browser_snapshot`'s numbers are the addressing space for the other tools; tool names are the wire action names (shared by bridge and extension).
