> [English](../en/extension.md) | [中文](../zh/extension.md)

# Chrome extension (packages/extension)

An MV3 extension in three parts: **service worker (control center) + content script (the only part that touches the DOM) + side panel (chat UI)**. It never talks to dsh sessions directly — everything goes through the background.

## The three parts

| Part | Responsibility | Key files |
|---|---|---|
| **background/** | bridge client (discovery/reconnect/heartbeat), RPC forwarding, tool dispatch, approval coordination, current-page tracking, logging | `index.ts` (assembly), `bridge.ts`, `tools.ts`, `authorization.ts`, `approval-coordinator.ts` |
| **content/** | page → text snapshot, perform click/type/scroll/navigate, stable numbering, sensitive masking | `snapshot.ts`, `extract.ts`, `actions.ts`, `ids.ts`, `privacy.ts` |
| **panel/** | simple chat, connection status, logs, approval box, Q&A box | `main.ts`, `index.html` |

## Core mechanisms

### Connection & liveness
- **Discovery**: probe ports → `fetch /ext/bridge-config` → `WebSocket` → `hello` handshake.
- **Reconnect**: exponential backoff (500ms→10s cap + jitter); `4000` means "superseded" and stops directly without mutual kicking.
- **Anti SW suspension**: panel 20s heartbeat + 30s alarm, double insurance against idle suspension killing the WebSocket; on disconnect clears "working", on reconnect pulls `session.history` to recover missed final output.

### Tool dispatch & approval
- Receives `tool.call` → resolves the controlled tab → builds an approval prompt (`authorization.ts` pure function) → routes through `approval-coordinator` (60s window) if approval is needed → dispatches to the content script → `tool.result`.
- **Reads default to auto** (`browser_snapshot`/`get_text`); **writes are always fail-closed approval**; no panel → timeout reject.
- Validates "target still valid" before dispatch (document id match), avoiding wrong actions if the page changed during approval.

### Page snapshot (text-first)
- **Stable numbering**: `WeakMap<Element,number>` one-time assignment + `data-dsh-el`, stable across snapshots.
- **Naming**: aria-label → label → aria-labelledby → visible text → placeholder (the ARIA priority chain in `extract.ts`).
- **Body extraction**: "readability-lite" — `<main>` → single `<article>` → largest text block with ≥2 paragraphs, scored.
- **Delta snapshots**: return only changes/removals/renumbering to save tokens.
- **iframes**: discovered via `webNavigation.getAllFrames`; the main frame gets an 80% budget, subframes split the rest; addressed as `(frame,index)`.
- **Settle detection**: `MutationObserver` + `readystatechange`, layered by action type (click/type/scroll each have their own strategy); stable pages return in seconds, continuous animation has a hard cap.

### Privacy
- Passwords/card numbers/CVV are detected by `type=password`, `autocomplete=cc-*`, id/name/aria-label regexes, masked as `••••`, and never sent back.
- Page text is wrapped in a random-nonce "untrusted content" boundary to prevent prompt injection (defense in depth; approval is the enforcing boundary).

### Current-page awareness
- `tabs.onActivated`/`onUpdated`/`windows.onFocusChanged` track the active tab (URL + title), shown live in the panel, and injected on `session.prompt` as `[浏览器上下文] 用户当前停留的页面: …` to give the model context.

### Chat & interaction
- **Simple chat**: `session.create` → `session.prompt` → subscribe to the `event` stream and render; the "working" indicator covers the whole "think → call tools → execute → output" flow (strictly follows the turn: `turn/start` shows, `turn/end` clears, intermediate text/tool events do not clear).
- **dsh questions** (`ask_user_question`): `question/requested` pops a question box (options / custom input), answers return via `respond`.
- **Status/logs**: a top status bar (connection state + address + reconnect count + current page) + a collapsible log panel (info/warn/error color-coded, ring-buffer replay).

## Security model

| Boundary | Mechanism |
|---|---|
| Bridge auth | bearer token (5s hello, constant-time) |
| Loopback passwordless | only `chrome-extension://` Origin |
| Privileged methods | reject `settings.*`/`credentials.*`/`host.open*` for non-loopback |
| Page data | text-only, no screenshots; sensitive fields masked; untrusted-content wrapping |
| Actions | writes fail-closed approval, reads follow ask/auto/off policy |
