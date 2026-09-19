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
│    panel/       side panel: chat, session picker, slash commands,     │
│                 model selection, region capture, markdown,            │
│                 status/logs, approval, Q&A, system config (12 modules)│
│    common/      shared stateless tools + UI components (reusable)      │
└─────────────────────────────────────────────────────────────────────────┘
```

## The three packages

| Package | Runs in | Responsibility | Has runtime logic |
|---|---|---|---|
| `packages/protocol` | both sides | frame types, constants, parsers, type guards | no (pure types + pure functions, zero deps) |
| `packages/bridge-dsh` | dsh process | mount routes, register tools, wire browser abilities into the model | yes |
| `packages/extension` | Chrome | perform browser actions, render chat, user approval | yes |

**The protocol is the single source of truth**: both sides import the same `protocol.ts`, so frame structures cannot drift; the `isServerFrame`/`isClientFrame` type guards separate send/receive directions at the type level. **Tool semantics share the same source**: the `browser-tools.ts` registry declares the 12 tool names, their action classes (read/observe/mutate/navigate) and the delta/navigation flags; the bridge tier gate and the extension approval/snapshot policies all derive from it, and an unregistered tool name is refused bridge-side with `unknown-tool` and zero frames (drift guard: `pnpm check:tool-registry`). The frame inventory, constants and RPC method families are documented in [protocol.md](protocol.md).

**Code organization & type safety**: the extension splits into `background/` (control center), `content/` (the only DOM-touching part), `panel/` (a thin composition root over 12 single-responsibility modules), and a shared `common/` (`tools/` + `ui/`) reused across surfaces. Shared vocabulary sinks downward: `background/types.ts` gathers the tool-call types, and `BridgeState`/`RegionElement` live in `common/`, keeping the dependency direction one-way (no panel→background or background→content type imports, no module cycles). All three packages type-check with `tsc` — the extension ships a local `chrome.d.ts` + `vendor.d.ts` because no `@types/chrome` is available offline.

## End-to-end data flow

1. **Discovery**: with an empty `host` the extension probes ports `3080/3081/3090/14389/43189` and `fetch /ext/bridge-config` to get the wsUrl; with a configured `host` it connects to that address directly (`ws://` and `/ext/bridge` appended as needed) — only the connection itself can fail, and it never falls back to local discovery. A remote address can be verified first with `Test connection` in the panel's System config, which runs one isolated handshake.
2. **Handshake**: after the WebSocket connects, the first frame must be `hello{token,caps}` (5s timeout); the server validates the token → replies `hello.ok` (negotiates the snapshot budget).
3. **Session**: panel `session.create` / `session.prompt` / slash-vocabulary `commands.list`, `commands.execute` and `skills.list` → `rpc` frame → bridge forwards to Typert Gateway → dsh executes → `rpc.result`.
4. **Event stream**: dsh session events (`user/message`, `assistant/message`, `turn/end`, `question/requested`, and the command lifecycle `command/run`/`command/done`) are streamed to the panel as `event` frames.
5. **Browser actions**: the model calls `browser_*` → **the bridge's tier gate** (folds `exec.agent.session`'s own knob events — `permission/preset` + `sandbox/mode` + `approval/policy` — to solve the session tier: `read-only` refuses page changes and page opening without sending a frame, `workspace-write` allows and sends "needs approval", `danger-full-access` allows and sends "execute directly"; a tier that cannot be solved fails explicitly with a stable error code and **never falls back to any tier**) → bridge sends `tool.call{policy}` → the extension background decides "raise the confirmation dialog / execute directly" from the frame's policy and routes to the content script → `tool.result` returns to the model. The `permissions` projection is read only for the deployment's preset table and for cross-checking the fold (on divergence the stricter side gates, and the divergence is recorded).
6. **Tier changes**: a switch in the panel or the dsh interface → the bridge runs dsh's `/permission <preset>` via `commands.execute` → the session's knob events are appended → the bridge pushes a `session/permission` event to the panel on an **actual** change, and on an actual drop uses `tool.cancel` to withdraw that session's in-flight browser calls (including ones already waiting on an approval). Whether a switch took effect is judged only by the projection flowing back equal to the target tier (the projection still drives display and switch confirmation; it just takes no part in the per-call gate).
7. **Region capture**: the panel's arrow button → background → content-script drag-select overlay → background crops `captureVisibleTab` to the selection → panel preview → `session.prompt` with the region image block + element list (dsh core admits the image and gates it to vision-capable models).

## Key design decisions

| Decision | Approach | Why |
|---|---|---|
| **Text-first, region capture** | model tools stay text-only; the panel adds a user-initiated drag-select that crops a screenshot and extracts intersecting DOM elements into the prompt | text stays cheap and diffable for tools; visuals are explicit, user-confirmed, and go only to vision-capable models |
| **Narrow interface isolates dsh versions** | the bridge depends only on `BrowserHostApi` (call/events/respond); business logic consumes the `host-streams.ts` transport primitives, and `remote-host-api.ts` only translates shapes | dsh 0.1.1 (ApiProxy) / 0.1.2 (0.1.3) (Typert) swap only the adapter layer; event generation and grouping stay untouched |
| **Single controlled tab** | tools bind to one tab; the active tab is bound on first call | prevents the model from silently switching to / peeking at other tabs |
| **Fail-closed approval** | reads default to auto; every write requires approval, no panel → timeout reject | the security boundary lives in the extension background, not in model goodwill |
| **Stable element numbering** | WeakMap one-time id assignment + `data-dsh-el` marker | addressable across snapshots, avoids mis-clicks after re-render |
| **Sensitive fields never leak** | passwords/card numbers/CVV masked as `••••`; page text wrapped in an untrusted marker | the snapshot is the only text exit, must be blocked here |
| **Shared common area, typed panel** | UI components + tools live once in `common/`; the panel is a composition root over 12 modules; `tsc` gates all three packages | no god-module; reuse instead of rewrite; type errors are caught before shipping |
| **MV3 survivability** | panel 20s heartbeat + 30s alarm reconnect + disconnect recovery | SW idle suspension kills WebSockets, must be counteracted |
