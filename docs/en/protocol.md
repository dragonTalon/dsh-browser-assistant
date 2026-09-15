> [English](../en/protocol.md) | [中文](../zh/protocol.md)

# Wire protocol (packages/protocol)

The two halves of this project — the dsh bridge plugin (Node) and the Chrome MV3 extension (browser) — share no runtime. They share **this package**: one JSON object per WebSocket message, discriminated by `t`, typed and validated once. Both sides import the same `protocol.ts`, so **a frame shape cannot drift** — a change made on only one side fails to compile instead of failing at runtime.

The package is **zero-dependency** (types, constants and pure functions only) and enters each build as a source alias, contributing no dependencies of its own.

## Module map

| File | Responsibility |
|---|---|
| `protocol.ts` | frames, constants, the `parseBridgeFrame` parser and the `isServerFrame`/`isClientFrame` guards — **the single source of truth** |
| `endpoint.ts` | how a user-typed address (`10.0.0.7:3080`, `wss://…`) becomes a bridge WebSocket URL |
| `prompt.ts` | region-capture prompt assembly + the page-context prefix prepended to every `session.prompt` |
| `index.ts` | barrel re-export (`export *`), so moving a module never touches importers |

## Transport

| Aspect | Value |
|---|---|
| Bridge route | `BRIDGE_PATH` = `/ext/bridge` — a WebSocket upgrade route mounted **outside** dsh's `/api` trust fence and carrying its own bearer token |
| Discovery | `BRIDGE_CONFIG_PATH` = `/ext/bridge-config` — returns `{ wsUrl }`, which is what makes zero-config local discovery possible |
| Framing | one JSON object per WebSocket message, discriminated by the string field `t` |
| Correlation | `id` is minted by the requestor and echoed by the responder; it is an **opaque string**, never parsed |
| Handshake deadline | `HELLO_TIMEOUT_MS` = 5s — the first frame must be `hello` |
| Liveness | `PING_INTERVAL_MS` = 30s server ping; the client answers `pong` |

## Handshake

```
   extension                                  bridge plugin
       │                                            │
       │  hello { token, caps }                     │  ← must arrive within 5s
       ├───────────────────────────────────────────▶│
       │                                            │  constant-time token compare
       │  hello.ok { caps }                         │
       │◀───────────────────────────────────────────┤
       │                                            │
       └─ on failure: error { code, message }, then the socket is closed
```

`caps` is `BridgeCaps`: `textOnly: true` (a literal type — the model tool pipeline never carries screenshots), `snapshotMaxChars` (the configured budget, minimum 500) and `maxInteractiveItems`. The client declares its own view in `hello`; the server replies with the **effective** bounds in `hello.ok`, which is where the snapshot budget is actually negotiated.

Two close codes carry meaning the panel renders literally: `4002` — the token was rejected; `4000` — this connection was superseded by a newer one (the bridge serves one extension connection at a time).

## Frame inventory

### Client → server (`ClientFrame`)

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `token`, `caps` | first frame, within 5s of socket open |
| `rpc` | `id`, `method`, `payload` | unary call, projected by the active Host adapter |
| `respond` | `id`, `rpcId`, `result` | answer or cancel a pending host interaction (e.g. `ask_user_question`) |
| `tool.result` | `id`, `ok: true`, `result` — or — `id`, `ok: false`, `error` | result of a previously dispatched tool call |
| `pong` | — | liveness reply |

### Server → client (`ServerFrame`)

| `t` | Fields | Meaning |
|---|---|---|
| `hello.ok` | `caps` | accepted after a valid `hello` |
| `rpc.result` | `id`, `ok: true`, `result` — or — `id`, `ok: false`, `error: { code, message }` | reply to an `rpc` frame |
| `respond.result` | `id`, `ok`, `result` / `error` | receipt for a `respond` frame (normally `{ accepted: boolean }`) |
| `event` | `frame: { rpcId, method, payload }` | one bridge-owned event envelope projected from Remote streams and waterfalls |
| `tool.call` | `id`, `name`, `args`, `expiresAt`, `sessionId?` | a model-requested browser action to execute in the user-controlled tab |
| `tool.cancel` | `id` | withdraw a tool call that timed out or whose caller was cancelled |
| `ping` | — | liveness probe |
| `error` | `code`, `message` | fatal connection error; the client should re-authenticate |

## Guards and parser

- `isServerFrame(frame)` / `isClientFrame(frame)` narrow by direction at the type level, so **server-side consumers never dispatch on their own request vocabulary** and client-side consumers never dispatch on the server's.
- `parseBridgeFrame(text)` is the only entry point for inbound text. It returns `undefined` — it never throws — for anything that is not a valid frame: malformed JSON, a non-object, a missing or non-string `t`, an unknown `t`, or a known `t` whose required fields are wrong. Consumers treat `undefined` as "drop this message".
- The parser is strict about the shapes it knows: `tool.call`, for example, requires a finite positive `expiresAt` and rejects a whitespace-only `sessionId`, while an absent `sessionId` stays absent.

## RPC methods

`rpc` frames are routed by method name, in two families.

**Bridge-local** — assembled by the plugin rather than forwarded:

| Method | Purpose |
|---|---|
| `session.history` / `workspace.list` | assembly layers over the gateway's `wireStream` (snapshot expansion / baseline read) |
| `model.catalog` | a purely in-process read of `llm` + `agentDefaultModel` |
| `skills.list` | one session's user-invocable skills |
| `commands.list` / `commands.execute` | one session's slash commands, and executing one command line |
| `bridge.injectBrowserSnapshot` | internal: seed the Agent's next step after an explicit tab handoff |
| `bridge.session.purge` | internal: permanently delete one session's durable storage |

**Passthrough** — everything else is forwarded to the dsh gateway by name (`session.*`, `settings.*`, `credentials.*`, `host.*`, …) under two protocol-level constraints:

- **Privilege fence**: `settings.*`, `credentials.*` and `host.open*` are rejected for non-loopback sources **even when the token is valid**.
- **Per-session ordering**: `session.prompt`, `session.cancel` and `commands.execute` are serialized per session, because a slash command mutates the state the next prompt runs under. Ordered calls run under an additional 120s bound; on expiry the bridge aborts that call's own signal, ends it as a failed `rpc.result` (code `timeout`) and **releases the queue slot**. See [bridge-plugin.md](bridge-plugin.md).

## Slash-vocabulary contracts

The three slash RPCs are the only ones whose payloads are typed in this package instead of passing as `unknown`. They are **types only** — zero runtime cost, no frame changes — and exist so a host-side field rename becomes a compile error rather than a silently missing column in the panel.

| Type | Role |
|---|---|
| `CommandsListRequest` | request body of `commands.list`: `{ sessionId }` |
| `CommandDescriptorWire` | one command: `name`, `description`, optional `input.hint` |
| `CommandInputDescriptorWire` | the optional free-form argument hint |
| `SkillsListRequest` | request body of `skills.list`: `{ sessionId }` |
| `SkillSummaryWire` | one skill: `name`, `description`, optional `whenToUse`, `modelInvocable` |
| `SkillsListValueWire` | the `{ skills: [...] }` envelope |
| `CommandExecuteRequest` | `{ sessionId, line }` — `line` is the whole command line, arguments included; `sessionId` exists for the bridge's ordering, not for the host |
| `CommandExecuteResult` | `{ commandId, result }`, where `result` is `{ kind: 'success', text?, sourceEventSeq? }` or `{ kind: 'error', text }` |

The host's own descriptors are the source of truth and these field names mirror them exactly. The types describe what a **well-formed** payload looks like, not a promise that one will arrive — the panel still parses defensively.

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `BRIDGE_PATH` | `/ext/bridge` | WebSocket upgrade route |
| `BRIDGE_CONFIG_PATH` | `/ext/bridge-config` | discovery endpoint |
| `HELLO_TIMEOUT_MS` | `5000` | deadline for the first frame |
| `PING_INTERVAL_MS` | `30000` | server ping cadence |
| `DEFAULT_TOKEN_BYTES` | `32` | 256-bit generated bearer token |
| `DEFAULT_SNAPSHOT_MAX_CHARS` | `32000` | default snapshot budget |
| `MIN_SNAPSHOT_MAX_CHARS` | `500` | smallest budget that can carry both trust boundaries and page text |
| `MAX_SCREENSHOT_BYTES` | `2000000` | cap on one region screenshot's encoded bytes, before base64 expansion |
| `MAX_REGION_ELEMENTS` | `30` | cap on the intersecting elements one region capture describes |

## Error vocabulary

`ToolErrorCode` is an **open set** — consumers must tolerate codes they do not know:

| Code | Meaning |
|---|---|
| `no-active-tab` | no controllable tab |
| `content-unavailable` | the content script is not reachable in that frame |
| `action-failed` | the page action itself failed |
| `timeout` | the call did not settle within its budget (also the ordered-RPC deadline code) |
| `bridge-closed` | the bridge went away mid-call |
| `bad-args` | the tool call's arguments were rejected |
| `internal` | unexpected bridge-side failure |

`ToolError` pairs such a code with human-readable text intended for the model.

## Prompt assembly

`prompt.ts` holds the vocabulary for building a `session.prompt`, kept here so both halves agree on the section labels:

- `PromptImagePart` — one image part a panel may append: `type: 'image'`, a `mediaType` from `PromptImageMediaType`, canonical base64 `data`, and an optional `name` that is never a filesystem path.
- `buildPageContext(title, url)` — the page-context prefix prepended to every prompt.
- `buildRegionScreenshotText(elementList)` / `buildRegionQuestionText(intent)` — the fixed-section layout of a region capture, with `EMPTY_INTENT` standing in when the user sends a selection without text.

## Invariants

These are the rules that keep the two halves one system:

1. **`protocol.ts` is the single source of truth.** Never redeclare a frame, constant or method name on either side.
2. **A new frame variant is a two-sided change.** Add it here, handle it on both ends, and rebuild both artifacts (`lib/index.js` and `dist/`) — the extension bundle aliases this source, so a rebuild is what makes the change real.
3. **Method names are constants**, not string literals sprinkled through the code.
4. **Correlation ids are opaque** and must be echoed unchanged.
5. **Error codes are an open set**; unknown codes are tolerated, never fatal.
6. **Directions are enforced by guards**, so neither side can dispatch on the other's vocabulary.
