> [English](../en/bridge-plugin.md) | [中文](../zh/bridge-plugin.md)

# dsh bridge plugin (packages/bridge-dsh)

A **Cordis plugin** that runs inside the dsh process. It does not modify dsh core and only takes effect when present in the profile's bundle list (opt-in). It does two things: **mount a WebSocket bridge** + **register `browser_*` tools**.

## Module responsibilities

| File | Responsibility |
|---|---|
| `index.ts` | plugin entry: declares `inject`, resolves config, registers routes/tools, dsh version probe, model-service probe |
| `protocol.ts` → [`@dsh-browser/protocol`](protocol.md) | frame types + parsers (shared with the extension, single source of truth) |
| `model-catalog.ts` | model catalog assembly: structural narrow interfaces for `llm`/`agentDefaultModel` + per-provider fault isolation |
| `server.ts` | WebSocket server: auth, single connection, RPC passthrough, tool dispatch, event pump |
| `remote-host-api.ts` | **pure Host adapter**: translates Typert Gateway + Connection into `BrowserHostApi` and the `host-streams.ts` primitives; carries no business logic |
| `host-api.ts` | narrow interface `BrowserHostApi` (call/events/respond), isolates dsh version differences |
| `host-streams.ts` | the four transport primitive interfaces (`SessionFollowSource`/`RemoteEventSource`/`HostInvoker`/`EventResultSender`), defined by the stream semantics business logic needs — not by the dsh 0.1.2 wire shape |
| `event-generation.ts` | host-agnostic event-generation business: session/follow lifecycle, disconnect backfill, cross-generation cursors, waterfall ownership, `AsyncEventQueue`; unit-testable against fake transports |
| `history-expand.ts` | pure chunkrow expansion (0.1.2 snapshots → scalar event model) |
| `session-grouping.ts` | host-agnostic workspace grouping: registration/retry/resolution over `HostInvoker` |
| `tools.ts` | 12 `browser_*` tool definitions (the model-facing contract); names and semantic classes come from the protocol-package registry (see below) |
| `token.ts` | bearer token generate/persist/constant-time compare |
| `extension-sessions.ts` | records extension-created sessions; decides who answers `ask_user_question` |
| `cordis.patch.yml` | patch applied when registering into a profile (`insert` this plugin + defaults) |

## Interface with dsh

The plugin declares `inject = ['webServer', 'typertGateway', 'connection', 'tools']` and depends only on these four services:

- `webServer`: `registerUpgrade` (mount `/ext/bridge`) + `register` (mount `/ext/bridge-config`) + `port`
- `typertGateway`: `invoke` (unary calls) + `wireStream.open` (long streams: `session/follow`, `$events`)
- `connection`: `createSharedFetchHandler('/api')` (return `$events/result` replies)
- `tools`: `ctx.tools.register` (register model-callable tools)

`remote-host-api.ts` converges these into `BrowserHostApi` and implements the `host-streams.ts` transport primitives (a follow of snapshot-then-increments, a remote stream of ready-then-events, unary invocation, outcome replies). Event generation and grouping consume only those primitives, decoupled from the dsh wire shape — **a dsh version evolution only rewrites the adapter's shape translation, with zero changes to the business modules** (backfill/dedup/follow-replacement are verified offline by `pnpm check:adapter-seam` against fake transports).

There is also a set of **probed optional services** (not in `inject`; discovered with `ctx.get` — when absent only `model.catalog` degrades, the plugin still boots):

- `llm`: `listProviders` / `listModels` — the only in-process way to reach `inputModalities` (the multimodal authority); no dsh `@Remote` surface carries it
- `agentDefaultModel`: `currentSelection` — the deployment default model selection

### Bridge-local RPCs

- `session.history` / `workspace.list`: assembly layers over gateway `wireStream` (snapshot expansion / baseline read).
- `model.catalog`: **purely in-process** read of `llm` + `agentDefaultModel`, returning `{ default, groups, failures }`; each provider's catalog lookup is isolated by its own try/catch into `failures` without dragging down the rest; when the services were not probed it returns `llm-unavailable` — the connection and other RPCs are unaffected.
- `skills.list`: forwards the extension's skill-catalog request to the gateway's `skills/list` (`args: { request: { sessionId } }`). **Skills are a namespace parallel to commands**: they have no execute endpoint, and are invoked by sending an ordinary `session.prompt` whose `/name` gesture the host's pre-step boundary answers by injecting the skill body. Unlike `commands.list` it resolves scope by *observing* the session through `sessionQuery`, so it does **not** resume an inactive session; when it fails the panel degrades to "no skills this time" without taking the command catalog down with it.
- `commands.list` / `commands.execute`: forward the extension's slash-command requests to the gateway's `commands/list` and `commands/execute`. The `sessionId` in the payload is resolved to a live Agent by the gateway's `agentId` lookup — a lookup the session controller *overrides* to "resume when no live agent exists", so it also resolves **an inactive historical session, at the price of genuinely resuming it** (opening the panel's menu is enough to trigger that). `commands.execute` must carry `sessionId` in its payload (see per-session serialization below) and sends `submittedAttachments` as an explicit empty array: a panel command never carries attachments, and a fixed wire shape beats relying on the endpoint's optional-parameter default. A missing or empty `sessionId`, or an empty `line`, is `bad-request`.

## Core mechanisms

| Mechanism | Implementation |
|---|---|
| **Auth** | the route sits outside the `/api` trust fence and carries its own bearer token: the first `hello` frame must carry the right token within 5s (constant-time compare); failure closes the connection |
| **Loopback passwordless** | loopback connections skip the token but require a `chrome-extension://` Origin (pages cannot forge this header); non-loopback must carry the token |
| **Privilege isolation** | `settings.*`/`credentials.*`/`host.open*` etc. are rejected for non-loopback sources **even with a token** (defends `--host 0.0.0.0` deployments) |
| **Single connection** | only one extension connection at a time; a new connection supersedes the old one (old socket gets 4000, in-flight tools settle as `bridge-closed`) |
| **RPC passthrough** | the extension's `rpc` frames are routed to the gateway by method name; `session.prompt`/`session.cancel`/`commands.execute` are serialized per session to preserve order — a slash command mutates the session state the next prompt runs under (`/plan off` is the example), so "command first, message next" must reach the host in the order the user performed it |
| **Bounded wait for ordered RPCs** | Serializing per session means one call holds that session's queue slot until it settles, and the host's command-execution endpoint answers only after its handler finishes (e.g. `/compact` summarizing a large conversation). Ordered RPCs therefore run under an additional 120s bound: on expiry the bridge aborts that call's own signal, ends it as a failed `rpc.result` (code `timeout`), and **releases the queue slot** so later prompts/cancels/executes on that session are not blocked indefinitely by one long command. The two guarantees differ in strength: **releasing the slot is hard** (driven by the call settling), while **aborting the host is best-effort** — the host's `withAbort` only wraps a promise, so a handler already running is not stopped, and honouring cancellation is each command's own choice (measured: `/compact` stops and appends its own `command/done`; `/goal`, `/permission`, `/feedback` and `/export` do not). The timeout wording therefore says only "did not answer within the limit, may still be running, the event stream owns the outcome" and **never claims the command was cancelled** |
| **Tool dispatch** | `tool.call` frames carry `expiresAt`; timeout/cancel sends `tool.cancel` to revoke; results are normalized to `{text}` via `tool.result` |
| **Event pump** | opens the `$events` stream on connect; opens `session/follow` for that session on the first `session.prompt`, turning incremental events into `event` frames |
| **Generation resubscription** | on reconnect a new event generation re-opens the latest session's `session/follow`; events missed during the disconnect are backfilled from snapshots via a cross-generation seq cursor (queued before any `session.history` reply, naturally deduped against panel re-render); recovery failure degrades silently without dragging down the new connection |
| **Question forwarding** | the `user-questions/request` waterfall in `$events` is forwarded as `question/requested` if it belongs to an extension session, otherwise `next()` hands it to dsh's native UI |

## Tool registry (single source of truth for tool semantics)

The names and semantic classifications of the 12 tools (action classes read/observe/mutate/navigate, page-delta attachment, navigation candidacy) are declared in exactly one place: `browser-tools.ts` in `@dsh-browser/protocol`. The tier gate's classification and the extension's approval / delta / navigation-snapshot policies all derive from the registry; no consumer may keep a local classification table — a tool added to one table but not another is exactly how a mutating action loses its tier gate.

- **Unregistered names fail closed**: the bridge fails any tool name the registry cannot classify with the stable error code `unknown-tool`, and writes **no `tool.call` frame** — the action never reaches the extension or the page, and no approval request is produced.
- **Drift guard**: `pnpm check:tool-registry` bundles the real sources and asserts every consumer derives exactly like the registry, that the `unknown-tool` refusal fires with zero frames (simulated by re-bundling against a protocol shim missing one descriptor), and greps the sources so no local classification literal may re-emerge.

## Permission tier gate

Authorization for browser write operations is decided per session tier, and it is decided on the bridge side: the extension only consumes the verdict.

**The source of truth is the session's own knob events.** dsh records the tier as three ordinary session events — `permission/preset` (the preset the user picked), `sandbox/mode`, and `approval/policy` — and the bridge folds those three. The `permissions` projection is derived from the same events, but reading it means traversing a registry lookup, a cell materialization and a schema parse; each layer can fail, and a failure is indistinguishable at the call site from "this deployment has no tier data". The fold is a pure function of the session log, so one log always yields one answer.

The projection is still read, for exactly two things: **learning which preset names the deployment advertises**, and **cross-checking** the fold. Neither replaces the fold as the gating input.

### Three outcomes, never folded into each other

| Outcome | Meaning | Gate behaviour |
|---|---|---|
| **Solved** | A folded preset name, or `custom` when the knobs match no preset | Judge by the tier |
| **No capability** | The deployment provably publishes no tier data (no preset table) | Omit the in-frame policy; the extension runs its pre-tier read/write behaviour |
| **Solve failed** | The session exists but its tier cannot be solved | Fail explicitly with the stable code `permission-tier-unresolved`, produce **no approval request**, and MUST NOT run under any tier |

A failed solve does **not** fall back to a deployment default tier. Continuing with a guessed tier means inventing an authorization the user never granted — which is precisely how "full access still shows a confirmation dialog" happens. Failure details carry the session id and the failing stage (`session-unreadable`, `malformed-knob-event`, `no-knob-events`, `preset-bundle-unknown`).

The model-visible failure text deliberately does **not** read as a tier refusal — that would send the model looking for another tool that performs the same act. It states that the tier could not be determined and names the retry path.

### Preset names come from the deployment's own table

A preset name carries no meaning by itself, so at mount time (once, never per call) the bridge probes the optional `permissionPresets` host service and resolves every advertised name into `{sandbox, approval}`, forming a complete bundle table; names it cannot resolve fall back to the projection's own declaration and then to dsh's three built-ins. A missing service does not stop the plugin from starting, and a name nobody can explain fails explicitly as `preset-bundle-unknown` rather than being guessed into some tier.

A preset name recorded by a session **need not** appear in the currently advertised list: a deployment may narrow its table, and the session log is the authority on what that session actually runs under.

`custom` (knobs matching no preset) is gated as the strictest tier, `read-only` — that is not "could not be read", it is "genuinely matches nothing".

### Cross-check and tightening

The fold is a **mirror** of dsh's derivation, and a mirror can be wrong, not merely unavailable. dsh derives the projection from the same events, so in a healthy deployment the two agree by construction; when they disagree the bridge **records it (with the session id) and gates on the stricter of the two** — two readings of the same authority must not resolve toward more permission. A failed projection read takes no part in the tightening; the fold stands unchanged.

Tier changes ride the `session/event` append feed: only a real change pushes a `session/permission` event and (on a downgrade) withdraws that session's in-flight calls with `tool.cancel`. The extension is always told the tier the gate actually uses.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | string | auto-generated | fixed bearer token; when absent, generated on first boot and persisted to `~/.dsh/ext-bridge-token` (0600) |
| `toolTimeoutMs` | number | 90000 | per-tool-call budget (covers the extension's 60s approval window) |
| `snapshotMaxChars` | number | 32000 | max characters per snapshot (min 500, negotiated to the extension via `hello.ok`) |
| `maxInteractiveItems` | number | 60 | max interactive inventory items per snapshot |
| `sessionWorkspace` | string | off | which Workspace owns extension-created Sessions: an **existing** absolute directory path; absent, empty, or whitespace-only leaves the feature off |

### Session workspace grouping (`sessionWorkspace`)

When configured, forwarding an extension-originated `session.create` first registers that directory as a dsh Workspace (**idempotently**), then injects the resolved `workspaceId` so the new Session becomes a member of that Workspace — shown in the dsh GUI sidebar grouped under the directory's basename instead of piling up in "Ungrouped".

Note that grouping is decided solely by the Workspace's **membership account** (`sessionIds`), never by comparing `cwd`; adding a `cwd` alone therefore produces no grouping — only a `workspaceId` does.

- **New Sessions only**: dsh's only adoption entry point requires the Session header's `cwd` to equal the Workspace path, so historical Sessions (different cwd) cannot be migrated; handle those in the GUI.
- **Explicit location wins**: nothing is injected when the request already carries `workspaceId` or `cwd`; the caller's choice passes through untouched.
- **Failure never blocks Session creation**: a missing directory or a rejected registration still creates the Session (it merely falls back to "Ungrouped") and emits one diagnostic line carrying the configured path. Registration failures are split in two: a **transient** cause (gateway still starting, a call that timed out, an answer that was lost) is retried once **inside the same** `session.create`, so a deployment whose Workspace does not exist yet gets it created before the Session starts; a **permanent** cause (path does not exist, request rejected) is not retried pointlessly and falls straight back to "Ungrouped". Failures are **never cached permanently**, so a recovered directory re-registers on the next Session.
- **Configuration is authoritative**: deleting the Workspace in the GUI makes the next extension-created Session register it again. To turn the feature off, remove this key rather than deleting the Workspace.
- **No directory creation**: the plugin does not create directories (that would mask a path typo); existence is the deployment's responsibility.

### Diagnosing "the conversation is not in the group"

Grouping can only happen at the moment the extension issues `session.create` — that is the one point where the bridge can inject a `workspaceId`. A Session that exists in dsh but sits outside the group is therefore one of exactly three things, and each is readable from the logs and the registry:

1. **The config never took effect**: mounting the plugin logs `会话分组已启用，扩展创建的会话将归入工作区 <path>`. Without that line, this dsh process never read `sessionWorkspace` (the key lives in another profile, or the process was not restarted after the edit).
2. **Registration did not succeed**: every resolution leaves a trace — `正在把 <path> 注册为 dsh 工作区…`, then either `工作区已解析 workspaceId=…` (success; later Sessions reuse that identity) or `sessionWorkspace … 注册失败（<code>: <message>）…` (failure; this Session stays ungrouped, the failure is never cached, the next one retries). A caller that cancelled early leaves `session.create 到达时调用方已取消…`.
3. **The Session predates grouping**: Sessions created before the registration are not grouped retroactively. The script below diffs the registry's membership against the Session files that actually exist under that directory:

```sh
pnpm check:grouping:status                     # defaults to packages/bridge-dsh
node scripts/check-grouping-status.mjs <dir>   # check a specific directory
```

Historical Sessions cannot be migrated by the bridge (see above), so only the GUI side or a new Session can move one into the group; the script exists to make that **decidable** rather than guessed.

> Keep machine-specific absolute paths **out of** the published `cordis.patch.yml`; put them in the profile override layer, which is applied after every bundle layer and hot-reloaded with the profile:
>
> ```yaml
> - id: bridge-dsh
>   config:
>     sessionWorkspace: /absolute/path/to/your/project
> ```

## Tool list

| Tool | Purpose |
|---|---|
| `browser_snapshot` | structured text snapshot (title/URL/body/numbered inventory/forms); `delta:true` returns only changes |
| `browser_click` / `browser_type` / `browser_press` | click / type (React/Vue compatible) / key press by stable number |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` | scroll / navigate / new tab |
| `browser_back` / `browser_forward` / `browser_reload` | history back/forward / reload |
| `browser_get_text` / `browser_wait` | read a region's text / wait for the page to settle |

Every tool produces a single `{text}`; `browser_snapshot`'s numbers are the addressing space for the other tools; tool names are the wire action names (shared by bridge and extension).
