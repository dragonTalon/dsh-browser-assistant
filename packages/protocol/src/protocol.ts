/**
 * Wire contract between the dsh bridge plugin and the browser extension.
 *
 * Zero-dependency module (pure types, constants, and a parser): both the
 * plugin (node) and the Chrome extension (browser bundle) import this file, so
 * the frame shapes can never drift between the two halves.
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
 *
 * @module
 */

/** WebSocket pathname the bridge plugin registers on the host webserver. */
export const BRIDGE_PATH = '/ext/bridge'

/** Zero-config discovery endpoint: returns `{ wsUrl }` for the extension. */
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/** Internal RPC used after an explicit tab handoff to seed the Agent's next step. */
export const BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD = 'bridge.injectBrowserSnapshot'

/** Internal RPC used by the panel to permanently delete one session's durable storage. */
export const BRIDGE_SESSION_PURGE_METHOD = 'bridge.session.purge'

/** RPC listing the human slash commands one session resolves. Payload: `{ sessionId }`. */
export const BRIDGE_COMMANDS_LIST_METHOD = 'commands.list'

/**
 * RPC executing one slash-command line against a session. Payload carries
 * `sessionId` alongside the host-facing `line` because the bridge serializes
 * session mutations by that field.
 */
export const BRIDGE_COMMANDS_EXECUTE_METHOD = 'commands.execute'

/**
 * RPC listing the user-invocable skills one session resolves. Payload:
 * `{ sessionId }`. Skills are a namespace parallel to commands: they have no
 * execute endpoint, and are invoked by sending `/<name>` as an ordinary prompt
 * so the host's pre-step boundary injects the skill body.
 */
export const BRIDGE_SKILLS_LIST_METHOD = 'skills.list'

/**
 * RPC switching one session's permission tier. Payload carries `sessionId`
 * alongside the target `preset` because the bridge resolves the preset against
 * that session's own advertised tier set.
 */
export const BRIDGE_PERMISSION_SET_METHOD = 'permission.set'

/**
 * Event method carrying a session's permission tier after it actually changed.
 * Emitted only on a real change, so a repeated identical value never produces a
 * frame. Rides the existing `{ t: 'event' }` envelope — no new frame type.
 */
export const BRIDGE_SESSION_PERMISSION_EVENT = 'session/permission'

/*
 * Permission-tier vocabulary.
 *
 * The tier is a property of the dsh session, not of this wire: the bridge
 * solves it from the session's permission projection and the extension only
 * consumes the resulting per-call policy. The tier names here mirror the dsh
 * permission presets exactly (`read-only` / `workspace-write` /
 * `danger-full-access`), plus `custom` for the derived not-a-preset state.
 */

/**
 * The dsh-BUILT-IN tier names, excluding the derived `custom`.
 *
 * This is a vocabulary, NOT a whitelist: a deployment may publish its own
 * preset names, and every one of them is as legitimate as these three. A
 * consumer MUST take the valid names from what the deployment advertises rather
 * than from this list — treating it as a whitelist folds a deployment's own
 * preset into the strictest tier and refuses work the user did authorize.
 */
export const BRIDGE_PERMISSION_TIERS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * The derived not-a-preset tier dsh reports when the effective sandbox mode and
 * approval policy match no preset entry. It is display state, never a switch
 * target.
 */
export const CUSTOM_PERMISSION_VALUE = 'custom'

/** One tier name as dsh publishes it. */
export type BridgePermissionTier = typeof BRIDGE_PERMISSION_TIERS[number] | 'custom'

/**
 * The tier that stands in for a CONFIRMED ABSENT tier capability — an older dsh
 * that publishes no permission data at all. Chosen as `workspace-write` so the
 * fallback preserves the pre-tier behavior: page reads per the sharing
 * preference, page-changing actions always confirmed.
 *
 * It MUST NOT be used for "the tier could not be solved this time". Those are
 * different facts with different correct answers: a deployment that has no
 * capability really does behave as this constant describes, whereas a failed
 * solve knows nothing about the session's authority — substituting this value
 * there would invent a tier the user never selected. A failed solve must
 * surface as a diagnosable failure instead.
 */
export const BRIDGE_DEFAULT_PERMISSION_TIER: BridgePermissionTier = 'workspace-write'

/**
 * Per-call authorization the bridge solved for one tool call. This is the
 * bridge's CONCLUSION, not an extension input: the extension must apply it
 * verbatim and must never derive a tier from local state.
 *
 * `ask` is the fallback whenever a `tool.call` frame omits the field, so a new
 * extension talking to an older bridge keeps the pre-tier behavior and no
 * upgrade ordering can open an unconfirmed action window.
 */
export type ToolCallPolicy =
  /** Run the action without producing an approval request. */
  | 'auto'
  /** Produce an approval request; no answer means refusal (fail-closed). */
  | 'ask'

/** Fallback policy for a `tool.call` frame that carries none. */
export const DEFAULT_TOOL_CALL_POLICY: ToolCallPolicy = 'ask'

/**
 * Request body of {@link BRIDGE_PERMISSION_SET_METHOD}. `preset` is the target
 * tier name; the bridge rejects anything outside the session's advertised set.
 */
export interface PermissionSetRequest {
  /** Session whose tier is being switched. */
  readonly sessionId: string
  /** Target tier name. Must be one of the session's advertised tiers. */
  readonly preset: string
}

/** Payload of {@link BRIDGE_SESSION_PERMISSION_EVENT}. */
export interface SessionPermissionEvent {
  /** Session whose tier changed. */
  readonly sessionId: string
  /** The tier now in effect, as dsh reports it. */
  readonly value: BridgePermissionTier
}

/*
 * Wire contracts for the slash-command RPCs above.
 *
 * These are the shapes that actually cross the boundary, stated once so both
 * ends type against the same thing. They are types only — no runtime cost, and
 * no frame changes — which is what keeps a host-side field rename a compile
 * error here instead of a silently missing column in the panel.
 *
 * The host's own descriptors are the source of truth; the field names below
 * mirror them exactly (`CommandDescriptor`, `SkillListValue`, `CommandResult`
 * in the harness checkout). A panel parsing a host payload stays defensive —
 * these types describe what a well-formed payload looks like, not a promise
 * that one will arrive.
 */

/** Request body of {@link BRIDGE_COMMANDS_LIST_METHOD}. */
export interface CommandsListRequest {
  /** Session whose Agent resolves the command view. */
  readonly sessionId: string
}

/** Optional free-form argument hint a command advertises. */
export interface CommandInputDescriptorWire {
  /** Hint text; present only when the host published one. */
  readonly hint?: string
}

/**
 * One command descriptor as the host publishes it. Only `name` and
 * `description` are required; a panel must still surface a descriptor whose
 * optional fields are absent rather than dropping it.
 */
export interface CommandDescriptorWire {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary shown verbatim. */
  readonly description: string
  /** Optional input hint; absent when the host published none. */
  readonly input?: CommandInputDescriptorWire
}

/** Request body of {@link BRIDGE_SKILLS_LIST_METHOD}. */
export interface SkillsListRequest {
  /** Session whose composition selects the skill view. */
  readonly sessionId: string
}

/** One user-invocable skill as the host publishes it. */
export interface SkillSummaryWire {
  /** Skill name without the leading slash. */
  readonly name: string
  /** Human-readable summary shown verbatim. */
  readonly description: string
  /** Usage guidance; absent when the host published none. */
  readonly whenToUse?: string
  /** False when only a human may invoke it. */
  readonly modelInvocable: boolean
}

/** Envelope returned by {@link BRIDGE_SKILLS_LIST_METHOD}. */
export interface SkillsListValueWire {
  readonly skills: readonly SkillSummaryWire[]
}

/**
 * Request body of {@link BRIDGE_COMMANDS_EXECUTE_METHOD}. `line` is the whole
 * command line, arguments included: the host owns each command's grammar.
 * `sessionId` is carried for the bridge's per-session ordering, not by the host.
 */
export interface CommandExecuteRequest {
  readonly sessionId: string
  /** Complete command line, leading slash included. */
  readonly line: string
}

/** Outcome of one executed command line. */
export interface CommandExecuteResult {
  /** Pairing id carried by this execution's lifecycle events. */
  readonly commandId: string
  /** The handler's verbatim outcome. */
  readonly result:
    | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: 'error'; readonly text: string }
}

/** Seconds a fresh socket may take to present `hello` before it is closed. */
export const HELLO_TIMEOUT_MS = 5_000

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30_000

/** Default bytes of the generated bearer token (256-bit). */
export const DEFAULT_TOKEN_BYTES = 32

/** Default rendered-snapshot character budget. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000

/** Smallest snapshot budget that can carry both trust boundaries and page text. */
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** Raster media types accepted for prompt image parts (mirrors the dsh attachment vocabulary). */
export type PromptImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One image part a panel may append to a `session.prompt` content array. */
export interface PromptImagePart {
  readonly type: 'image'
  readonly mediaType: PromptImageMediaType
  /** Canonical base64 of the image bytes (no data-URL prefix). */
  readonly data: string
  /** Optional display name; never a filesystem path. */
  readonly name?: string
}

/** Upper bound on one region screenshot's encoded bytes (before base64 expansion). */
export const MAX_SCREENSHOT_BYTES = 2_000_000

/** Cap on how many intersecting elements one region capture describes. */
export const MAX_REGION_ELEMENTS = 30

/** Error codes a tool call may settle with. Open set: consumers must tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'
  /** The session's permission tier forbids this action class (read-only tier). */
  | 'permission-tier-denied'
  /**
   * The session's tier could not be solved, so no authorization could be
   * established. Distinct from `permission-tier-denied` on purpose: that code
   * asserts a tier refused the action, while this one asserts nothing is known
   * about the tier. Consumers must not let the model read this as "another tool
   * might be allowed".
   */
  | 'permission-tier-unresolved'
  /**
   * The tool name is not in the shared browser-tool registry. A registered
   * tool that lost its classification is as unregistered as a name the
   * registry never had: the call is refused before any `tool.call` frame is
   * written, so the action never reaches the extension or the page.
   */
  | 'unknown-tool'

/** Stable error codes a permission-tier RPC may fail with, understood by the panel. */
export const PERMISSION_ERROR_CODES = {
  /** The session does not advertise this preset name. */
  unknownPreset: 'permission-unknown-preset',
  /** `custom` is a derived display state and is never a switch target. */
  customNotSwitchable: 'permission-custom-not-switchable',
  /** The connected dsh exposes no permission-tier capability at all. */
  capabilityUnavailable: 'permission-capability-unavailable',
} as const

/** One {@link PERMISSION_ERROR_CODES} value. */
export type PermissionErrorCode = typeof PERMISSION_ERROR_CODES[keyof typeof PERMISSION_ERROR_CODES]

/** One tool-call failure: stable machine code plus human text for the model. */
export interface ToolError {
  code: ToolErrorCode
  message: string
}

/** Result sent for a pending host interaction such as ask_user_question. */
export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** Capabilities negotiated in `hello`/`hello.ok`. The extension performs its own actions; these bounds shape page snapshots. */
export interface BridgeCaps {
  /** The extension renders page state as text only (no screenshots). */
  textOnly: true
  /** Upper bound on one rendered snapshot's characters (plugin config, minimum 500). */
  snapshotMaxChars: number
  /** Upper bound on interactive inventory items per snapshot (plugin config). */
  maxInteractiveItems: number
}

/** Frames sent by the extension to the bridge plugin. */
export type ClientFrame =
  /** First frame, within HELLO_TIMEOUT_MS of socket open. */
  | { t: 'hello'; token: string; caps: BridgeCaps }
  /** Unary call projected by the active dsh Host adapter. */
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  /** Answer or cancel a pending Host interaction waterfall. */
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  /** Result of a previously dispatched tool call. */
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  /** Liveness reply. */
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the extension. */
export type ServerFrame =
  /** Accepted after a valid `hello`. */
  | { t: 'hello.ok'; caps: BridgeCaps }
  /** Reply to an `rpc` frame; `result` is the bridge's stable ServerResponse envelope. */
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  /** Receipt for a `respond` frame (normally `{ accepted: boolean }`). */
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  /** One bridge-owned event envelope projected from Remote streams and waterfalls. */
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  /** A model-requested browser action to execute in the user-controlled tab. */
  | {
    t: 'tool.call'
    id: string
    name: string
    args: Record<string, unknown>
    expiresAt: number
    sessionId?: string
    /**
     * The bridge's solved authorization for THIS call.
     *
     * Omitted in exactly one situation: the connected dsh is CONFIRMED to have
     * no permission-tier capability, and an extension must then treat it as
     * `ask` (see {@link DEFAULT_TOOL_CALL_POLICY}). A tier that exists but
     * could not be solved is not this case — that call does not reach the
     * extension at all, because the bridge fails it as diagnosable rather than
     * sending an authorization it cannot vouch for.
     */
    policy?: ToolCallPolicy
  }
  /** Withdraw a tool call that timed out or whose caller was cancelled. */
  | { t: 'tool.cancel'; id: string }
  /** Liveness probe. */
  | { t: 'ping' }
  /** Fatal connection error; the client should re-authenticate. */
  | { t: 'error'; code: string; message: string }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/**
 * Type guard: is this frame one the SERVER may send? Client-only shapes
 * (hello/tool.result/pong) narrow out, so server-side consumers never
 * dispatch on their own request vocabulary.
 * @param frame - parsed frame.
 * @returns true for server-sendable frames.
 */
export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'ping'
    || frame.t === 'error'
}

/**
 * Type guard: is this frame one the CLIENT may send? Server-only shapes
 * narrow out, so client-side consumers never dispatch on server vocabulary.
 * @param frame - parsed frame.
 * @returns true for client-sendable frames.
 */
export function isClientFrame(frame: BridgeFrame): frame is ClientFrame {
  return frame.t === 'hello' || frame.t === 'rpc' || frame.t === 'respond' || frame.t === 'tool.result' || frame.t === 'pong'
}

/**
 * Parse one WebSocket message into a frame.
 * @param text - raw message text.
 * @returns the frame, or `undefined` when the message is not a valid frame.
 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return typeof frame.token === 'string'
        && isCaps(frame.caps)
        ? { t: 'hello', token: frame.token, caps: frame.caps }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isToolError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps)
        ? { t: 'hello.ok', caps: frame.caps }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return typeof frame.error === 'object' && frame.error !== null
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error as { code: string; message: string } }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isWireError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return typeof frame.frame === 'object' && frame.frame !== null
        ? { t: 'event', frame: frame.frame as ServerFrame extends { t: 'event' } ? ServerFrame['frame'] : never }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined
        && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string' && typeof frame.name === 'string'
        && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
        && typeof frame.expiresAt === 'number' && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args as Record<string, unknown>,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
            // An unrecognized policy is dropped rather than rejected: the frame
            // stays usable and the consumer's own fallback (ask) applies, which
            // is the fail-closed reading of "this call's authorization is
            // unclear". Rejecting the whole frame would instead surface as a
            // dead call the model cannot diagnose.
            ...(isToolCallPolicy(frame.policy) ? { policy: frame.policy } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

/**
 * Type guard for the per-call authorization field.
 * @param value - candidate value off a parsed `tool.call` frame.
 * @returns true for the two known policies.
 */
function isToolCallPolicy(value: unknown): value is ToolCallPolicy {
  return value === 'auto' || value === 'ask'
}

function isCaps(value: unknown): value is BridgeCaps {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Record<string, unknown>
  return caps.textOnly === true
    && typeof caps.snapshotMaxChars === 'number'
    && Number.isInteger(caps.snapshotMaxChars)
    && caps.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof caps.maxInteractiveItems === 'number' && caps.maxInteractiveItems > 0
}

function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

function isWireError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

export function isRespondResult(value: unknown): value is RespondResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return result.error === undefined
  return result.ok === false && isRespondError(result.error)
}

function isRespondError(value: unknown): value is Extract<RespondResult, { ok: false }>['error'] {
  return isWireError(value)
    && typeof (value as Record<string, unknown>).details === 'object'
    && (value as Record<string, unknown>).details !== null
    && !Array.isArray((value as Record<string, unknown>).details)
}

// Prompt assembly vocabulary lives in prompt.ts but re-exports here so both the
// extension and the bridge import it from the single `@dsh-browser/protocol`
// surface (matching how the extension build aliases that specifier).
export * from './prompt.ts'
