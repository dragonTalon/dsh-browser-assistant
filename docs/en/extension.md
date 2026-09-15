> [English](../en/extension.md) | [中文](../zh/extension.md)

# Chrome extension (packages/extension)

An MV3 extension in three parts: **service worker (control center) + content script (the only part that touches the DOM) + side panel (chat UI)**. It never talks to dsh sessions directly — everything goes through the background.

## The three parts

| Part | Responsibility | Key files |
|---|---|---|
| **background/** | bridge client (discovery/reconnect/heartbeat), RPC forwarding, tool dispatch, approval coordination, current-page tracking, logging | `index.ts` (assembly), `bridge.ts`, `tools.ts`, `authorization.ts`, `approval-coordinator.ts` |
| **content/** | page → text snapshot, perform click/type/scroll/navigate, stable numbering, sensitive masking | `snapshot.ts`, `extract.ts`, `actions.ts`, `ids.ts`, `privacy.ts` |
| **panel/** | chat, status, model selection, region capture, Markdown rendering, logs, approval box, Q&A box, system config | `main.ts` (composition root) + `transport`/`conversation`/`model-selector`/`region`/`question`/`approval`/`status`/`settings`/`errors`/`log` + shared `common/` (`tools/` + `ui/`); `index.html` |

## Core mechanisms

### Connection & liveness
- **Discovery**: with an empty `host`, probe ports → `fetch /ext/bridge-config` → `WebSocket` → `hello` handshake.
- **Remote dsh**: the gear button in the status bar opens the **System config** dialog for `dsh host` + `token`. Four address forms are accepted — `10.0.0.7:3080`, `localhost:3080`, `wss://dsh.example.com`, and a full `ws://host:port/ext/bridge`: a missing scheme gets `ws://` plus `/ext/bridge`, an explicit scheme is kept (`http`/`https` map to `ws`/`wss`), and a sub-path is preserved for reverse proxies mounted off the root. A non-empty `host` **never falls back to local discovery** — a wrong remote address must read as unreachable, not quietly connect to this machine.
- **Verify at config time**: typing shows the effective address live (computed locally, no request); `Test connection` runs a full `hello` handshake on a **separate one-shot socket** (it never evicts the working connection) and reports the failure stage separately: malformed address / unreachable / reachable but token rejected (`4002`) / reachable but handshake timed out; `Save & reconnect` waits for the real reconnect and, on failure, keeps the dialog open with the input intact.
- **Token**: mandatory for remote connections (the server enforces it for every non-loopback source, no exceptions). Read it on the dsh machine with `cat ~/.dsh/ext-bridge-token`; pasted **surrounding whitespace is stripped automatically** — the token file ends with a newline and the server compares bytes exactly, so keeping it would reliably produce `4002`.
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
- `tabs.onActivated`/`onUpdated`/`windows.onFocusChanged` track the active tab (URL + title), shown live in the panel, and injected on `session.prompt` as `[网页描述]：<title> (<url>)` to give the model context.

### Chat & interaction
- **Simple chat**: the session identity comes from the session picker; the first send is what runs `session.create` → `session.prompt` → subscribe to the `event` stream and render; the "working" indicator covers the whole "think → call tools → execute → output" flow (strictly follows the turn: `turn/start` shows, `turn/end` clears, intermediate text/tool events do not clear).
- **Session picker**: the status bar's "session" dropdown, whose first entry is always "new session" and is selected by default. Candidates come from the read-only `session.list`: blank sessions and sub-agent sessions are excluded, the rest are ordered by most recent activity and capped at 50 (a disabled note marks the cut-off), each starting with a `[working-directory name]` bracket prefix (omitted when the directory is unknown) followed by the title (falling back to the first 8 characters of the session id), a running marker and the relative activity time. **Opening or reconnecting never creates a session** — only the first send (or the first model pick for this session) runs `session.create {}`, so an unused panel no longer leaves orphan sessions behind in dsh. Picking a past session binds it and replays `session.history` (clear, then replay in order; `hasMore` shows an "older messages not shown" notice at the top). It deliberately does **not** go through `session.create { sessionId }`: that path injects the bridge's configured `sessionWorkspace`, so a session living elsewhere fails with `session/conflict` and would be re-homed into that workspace; a cold session is resumed by dsh itself on the next prompt. Events are isolated per `sessionId` (leftover frames of the previous session are dropped at the switch), live frames arriving during a replay are buffered by `seq` and applied after it, switching never cancels the previous session's running turn, and switching back relies on the bridge's per-session cursor backfill. dsh questions and browser-action approvals are **deliberately not session-filtered**: while a session the user switched away from still has a pending interaction, the panel is its only answerer.
- **Model selection & capability marking**: the pill-shaped dropdown on the left of the composer (same position and feel as the dsh GUI) re-pulls `model.catalog` (read-only) after every connect. Current selection resolves in order: session-history `projections.values.modelSelection` `next` → `lastUsed` → catalog `default`; three sync channels — optimistic update on `session.selectModel` success, instant alignment on `model/selection` events, and projection fallback on reconnect `session.history`. Multimodal marking is ternary: `inputModalities` containing `image` → "vision", published without it → "text", unpublished or absent from the catalog → "capability unknown" (never guessed); the current model's capability also shows as a small badge beside the dropdown. Choosing in the dropdown calls `session.selectModel`; **that dsh behavior also rewrites the deployment default model** (`agentDefaultModel.saveSelection`) — the panel says so persistently in the selector tooltip. A catalog fetch failure shows "model unavailable" on the selector plus an error-coded line in the conversation, and never blocks chat.
- **dsh questions** (`ask_user_question`): `question/requested` pops a question box (options / custom input), answers return via `respond`.
- **Status/logs**: a top status bar (connection state + address + reconnect count + current page) + a collapsible log panel (info/warn/error color-coded, ring-buffer replay).

## Security model

| Boundary | Mechanism |
|---|---|
| Bridge auth | bearer token (5s hello, constant-time); mandatory for remote connections |
| Loopback passwordless | only `chrome-extension://` Origin |
| Privileged methods | non-loopback rejects `settings.*`/`credentials.*`/`host.openPath`/`host.pickDirectory` — **these features are unavailable on a remote connection**; the panel states it as "local dsh only" instead of echoing a raw error code |
| Connection target | `connect-src` allows any `ws://`/`wss://` (needed for remote deployments); only the target widened — token auth, approvals, and the loopback fence are unchanged |
| Page data | text-only, no screenshots; sensitive fields masked; untrusted-content wrapping |
| Actions | writes fail-closed approval, reads follow ask/auto/off policy |

### TLS reverse proxy (recommended for remote)

Plain `ws://` across a network sends page snapshots, prompts, and the token in the clear. Terminate TLS in front of dsh and connect with `wss://`:

```nginx
# dsh web listens on 127.0.0.1:3080; the proxy exposes only wss
server {
  listen 443 ssl;
  server_name dsh.example.com;
  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

  location /ext/ {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # /ext/bridge is a WebSocket upgrade
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                    # the bridge keeps alive via ping; don't idle-timeout it
  }
}
```

Enter `wss://dsh.example.com` in the dialog (the extension appends `/ext/bridge`); for a sub-path mount enter the full path (e.g. `wss://dsh.example.com/dsh/ext/bridge`). The token is still `~/.dsh/ext-bridge-token` **on the remote machine**.
