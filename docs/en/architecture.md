> [English](../en/architecture.md) | [中文](../zh/architecture.md)

# Overall Architecture

dsh-browser-assistant lets [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) read and operate the **real browser tabs the user already has open**. Pages are rendered as text-only structured snapshots, the model addresses elements by number, and login state and cookies are preserved throughout. For visual understanding, the user can also drag-select a page region from the side panel — the cropped screenshot plus the region's DOM element list is bundled into the prompt and sent to a vision-capable model.

In one sentence: **"a browser execution terminal for dsh" = a dsh bridge plugin (server side) + a Chrome MV3 extension (browser side), joined by one custom WebSocket.**

## Topology

```
┌───────────────────────── dsh process (Node) ──────────────────────────┐
│  packages/bridge-dsh (Cordis plugin, opt-in, no dsh core changes)     │
│    /ext/bridge-config   discovery endpoint: returns wsUrl              │
│    /ext/bridge          WebSocket upgrade route (outside /api fence)   │
│    12 browser_* tools (registered into ctx.tools)                      │
│    joins dsh via typertGateway + connection (0.1.2 / 0.1.3 arch)       │
└──────────────────────────────▲─────────────────────────────────────────┘
                               │ WebSocket (JSON frames, see packages/protocol)
┌──────────────────────────────┴─────────────────────────────────────────┐
│  packages/extension (Chrome MV3 extension)                             │
│    background/  service worker: bridge client, RPC, tool dispatch,     │
│                 approval, status logging                               │
│    content/     page side (the only DOM-touching part): snapshot/click/│
│                 input/privacy masking                                  │
│    panel/       side panel: chat, status, logs, approval, Q&A          │
└─────────────────────────────────────────────────────────────────────────┘
```

## The three packages

| Package | Runs in | Responsibility | Has runtime logic |
|---|---|---|---|
| `packages/protocol` | both sides | frame types, constants, parsers, type guards | no (pure types + pure functions, zero deps) |
| `packages/bridge-dsh` | dsh process | mount routes, register tools, wire browser abilities into the model | yes |
| `packages/extension` | Chrome | perform browser actions, render chat, user approval | yes |

**The protocol is the single source of truth**: both sides import the same `protocol.ts`, so frame structures cannot drift; the `isServerFrame`/`isClientFrame` type guards separate send/receive directions at the type level.

## End-to-end data flow

1. **Discovery**: the extension probes ports `3080/3081/3090/14389/43189` and `fetch /ext/bridge-config` to get the wsUrl.
2. **Handshake**: after the WebSocket connects, the first frame must be `hello{token,caps}` (5s timeout); the server validates the token → replies `hello.ok` (negotiates the snapshot budget).
3. **Session**: panel `session.create` / `session.prompt` → `rpc` frame → bridge forwards to Typert Gateway → dsh executes → `rpc.result`.
4. **Event stream**: dsh session events (`user/message`, `assistant/message`, `turn/end`, `question/requested`) are streamed to the panel as `event` frames.
5. **Browser actions**: the model calls `browser_*` → bridge sends `tool.call` → the extension background routes it to the content script → `tool.result` returns to the model.
6. **Region capture**: the panel's arrow button → background → content-script drag-select overlay → background crops `captureVisibleTab` to the selection → panel preview → `session.prompt` with the region image block + element list (dsh core admits the image and gates it to vision-capable models).

## Key design decisions

| Decision | Approach | Why |
|---|---|---|
| **Text-first, region capture** | model tools stay text-only; the panel adds a user-initiated drag-select that crops a screenshot and extracts intersecting DOM elements into the prompt | text stays cheap and diffable for tools; visuals are explicit, user-confirmed, and go only to vision-capable models |
| **Narrow interface isolates dsh versions** | the bridge depends only on `BrowserHostApi` (call/events/respond) | dsh 0.1.1 (ApiProxy) / 0.1.2 (0.1.3) (Typert) swap only the adapter layer |
| **Single controlled tab** | tools bind to one tab; the active tab is bound on first call | prevents the model from silently switching to / peeking at other tabs |
| **Fail-closed approval** | reads default to auto; every write requires approval, no panel → timeout reject | the security boundary lives in the extension background, not in model goodwill |
| **Stable element numbering** | WeakMap one-time id assignment + `data-dsh-el` marker | addressable across snapshots, avoids mis-clicks after re-render |
| **Sensitive fields never leak** | passwords/card numbers/CVV masked as `••••`; page text wrapped in an untrusted marker | the snapshot is the only text exit, must be blocked here |
| **MV3 survivability** | panel 20s heartbeat + 30s alarm reconnect + disconnect recovery | SW idle suspension kills WebSockets, must be counteracted |
