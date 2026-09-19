/**
 * dsh 0.1.2 Host adapter.
 *
 * Unary calls go directly through TypertGateway. Long-lived Session and
 * forwarded-event streams use the Gateway wire seam, while `$events/result`
 * goes through Connection because it is a Gateway-owned RPC endpoint rather
 * than a Typert Remote method.
 *
 * @module bridge-dsh
 */

import type {
  BrowserHostApi,
  HostEventFrame,
  HostRpcCall,
  HostRpcFailure,
  HostRpcResult,
} from './host-api.ts'
import { hostFailure, isRecord } from './host-api.ts'
import { ExtensionSessionRegistry } from './extension-sessions.ts'
import {
  buildBridgeModelCatalog,
  type ModelCatalogServices,
} from './model-catalog.ts'
import {
  BRIDGE_PERMISSION_SET_METHOD,
  CUSTOM_PERMISSION_VALUE,
  PERMISSION_ERROR_CODES,
  type CommandExecuteRequest,
  type RespondResult,
} from '@dsh-browser/protocol'
import type { PermissionServices } from './permission.ts'
import { EventGeneration, isSessionSnapshot } from './event-generation.ts'
import { historyPageValue, historyValue } from './history-expand.ts'
import { WorkspaceGrouper } from './session-grouping.ts'
import type {
  EventResultSender,
  FollowEntry,
  FollowSnapshot,
  HostInvoker,
  RemoteEvent,
  RemoteEventOutcome,
  RemoteEventSource,
  SessionFollowSource,
} from './host-streams.ts'

/** Structural subset of dsh 0.1.2's Host TypertGateway service. */
export interface TypertGatewayLike {
  readonly wireStream: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    failure(error: unknown): HostRpcFailure
  }
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/** Structural subset of dsh 0.1.2's Host Connection service. */
export interface HostConnectionLike {
  createSharedFetchHandler(channel: '/api'): {
    fetch(request: Request): Promise<Response>
  }
}

/**
 * Deployment inputs for placing extension-created Sessions in a dsh Workspace.
 * Forwarded verbatim into the {@link WorkspaceGrouper} (session-grouping.ts),
 * which owns the registration lifecycle. Absent, or with no `workspacePath`,
 * the forwarded `session.create` request must stay field-for-field identical
 * to the caller's.
 */
export interface SessionGroupingOptions {
  /** Absolute directory whose Workspace owns extension-created Sessions. */
  readonly workspacePath?: string
  /** Sink for non-fatal grouping diagnostics; absent → silent. */
  readonly warn?: (message: string) => void
  /** Sink for the resolution trace; absent → no trace is emitted. */
  readonly trace?: (message: string) => void
  /** Registration attempts one `session.create` may spend; forwarded. */
  readonly registrationAttempts?: number
  /** Wait between attempts, in ms; forwarded. */
  readonly registrationRetryDelayMs?: number
}

interface InvokeTarget {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly adapt?: (value: unknown) => unknown
}

/** dsh error code for a Workspace identity that no longer resolves. */
const WORKSPACE_NOT_FOUND = 'workspace/not-found'

/** Build the dsh 0.1.2 Host implementation. */
export function createRemoteHostApi(
  gateway: TypertGatewayLike,
  connection: HostConnectionLike,
  modelServices?: ModelCatalogServices,
  sessionGrouping?: SessionGroupingOptions,
  permissionServices?: PermissionServices,
): BrowserHostApi {
  return new RemoteHostApi(gateway, connection, modelServices, sessionGrouping, permissionServices)
}

/**
 * Read the failure text out of a command execution result.
 *
 * A command handler reports a rejected argument as `{ kind: 'error', text }`
 * inside a successful invoke, not as a rejection, so the caller must inspect
 * the envelope to tell "switched" from "no such preset".
 * @param value - the `commands.execute` result.
 * @returns the handler's error text, or undefined when the command succeeded.
 */
function commandErrorText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const result = value.result
  if (!isRecord(result) || result.kind !== 'error') return undefined
  return typeof result.text === 'string' && result.text !== ''
    ? result.text
    : 'the permission command rejected the request'
}

class RemoteHostApi implements BrowserHostApi {
  private readonly fetchHandler: ReturnType<HostConnectionLike['createSharedFetchHandler']>
  private readonly extensionSessions = new ExtensionSessionRegistry()
  /** Last known session/follow tip per Session; drives session/page throughSeq. */
  private readonly historyCursors = new Map<string, number>()
  /**
   * Session the latest EventGeneration followed; survives connection
   * generations so a fresh generation can re-establish the follow without
   * waiting for the extension's next RPC.
   */
  private lastFollowedSessionId: string | undefined
  private activeEvents: EventGeneration | undefined
  /**
   * HostInvoker primitive this adapter exposes to the business modules
   * (workspace grouping). The seam takes `unknown` args; the adapter narrows
   * them to the gateway's record shape.
   */
  private readonly hostInvoker: HostInvoker = {
    invoke: (namespace, method, args, signal) => this.gateway.invoke({
      namespace,
      method,
      args: args as Readonly<Record<string, unknown>>,
      signal,
    }),
  }
  /**
   * Session-follow primitive: translates the host's wire stream into the seam
   * shape — snapshot delivered separately, the incremental tail iterated.
   */
  private readonly followSource: SessionFollowSource = {
    open: (request, signal) => this.openFollow(request, signal),
  }
  /**
   * Remote-event primitive: consumes and validates the ready frame, reduces
   * it to `clientId`, and yields the remaining events.
   */
  private readonly remoteSource: RemoteEventSource = {
    open: (signal) => this.openRemoteEvents(signal),
  }
  /** Outcome-sender primitive, bound to the adapter's $events/result path. */
  private readonly resultSender: EventResultSender = {
    send: (clientId, eventId, outcome, signal) => this.sendRemoteEventResult(clientId, eventId, outcome, signal),
  }
  /** Workspace grouping, built from the deployment options when present. */
  private readonly grouper: WorkspaceGrouper | undefined
  /**
   * The deployment's grouping trace sink, kept for the adapter's own
   * "caller named its own location" line (the grouper owns the rest of the
   * resolution trace).
   */
  private readonly groupingTrace: ((message: string) => void) | undefined

  constructor(
    private readonly gateway: TypertGatewayLike,
    connection: HostConnectionLike,
    /** Probed `llm`/`agentDefaultModel` pair; absent → model.catalog fails cleanly. */
    private readonly modelServices?: ModelCatalogServices,
    /** Deployment Session-grouping inputs; absent → create requests stay untouched. */
    sessionGrouping?: SessionGroupingOptions,
    /** Probed projection accessors; absent → the bridge reports no tier capability. */
    private readonly permissionServices?: PermissionServices,
  ) {
    this.fetchHandler = connection.createSharedFetchHandler('/api')
    this.groupingTrace = sessionGrouping?.trace
    this.grouper = sessionGrouping === undefined
      ? undefined
      : new WorkspaceGrouper({
          host: this.hostInvoker,
          workspacePath: sessionGrouping.workspacePath,
          warn: sessionGrouping.warn,
          trace: sessionGrouping.trace,
          registrationAttempts: sessionGrouping.registrationAttempts,
          registrationRetryDelayMs: sessionGrouping.registrationRetryDelayMs,
        })
  }

  /** Translate one `session/follow` open into the seam shape. */
  private async openFollow(
    request: { readonly sessionId: string; readonly maxMessages?: number },
    signal: AbortSignal,
  ): Promise<{ readonly snapshot: FollowSnapshot } & AsyncIterable<FollowEntry>> {
    const source = await this.gateway.wireStream.open(
      'session/follow',
      {
        args: {
          request: {
            address: { kind: 'session', sessionId: request.sessionId },
            ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
          },
        },
      },
      signal,
    )
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    // The consumer validates the snapshot shape itself; the adapter only
    // enforces that a snapshot position exists to be validated. The iterator
    // cast is the translation boundary: raw host frames are re-validated by
    // the event generation before anything consumes them.
    if (first.done) throw new TypeError('session/follow did not begin with a snapshot')
    return {
      snapshot: first.value as unknown as FollowSnapshot,
      [Symbol.asyncIterator]: () => iterator as AsyncIterator<FollowEntry>,
    }
  }

  /** Translate one `$events` open into the seam shape (ready reduced to clientId). */
  private async openRemoteEvents(
    signal: AbortSignal,
  ): Promise<{ readonly clientId: string } & AsyncIterable<RemoteEvent>> {
    const source = await this.gateway.wireStream.open('$events', { args: {} }, signal)
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || !isRemoteEventReady(first.value)) {
      throw new TypeError('$events did not begin with ready')
    }
    return {
      clientId: first.value.clientId,
      [Symbol.asyncIterator]: () => iterator,
    }
  }

  async call(call: HostRpcCall): Promise<HostRpcResult> {
    if (call.method === 'session.history') return this.sessionHistory(call)
    if (call.method === 'workspace.list') return this.workspaceList(call)
    if (call.method === 'model.catalog') return this.modelCatalog()
    if (call.method === BRIDGE_PERMISSION_SET_METHOD) return this.permissionSet(call)

    const target = invokeTarget(call)
    if ('error' in target) return { ok: false, error: target.error }

    try {
      // Deferred Sessions have no history call with which to establish the
      // follower. Open it after materialization and before prompt admission,
      // so the first user/turn events cannot race past the extension.
      if (call.method === 'session.prompt') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId !== undefined) await this.activeEvents?.ensureSessionFollow(sessionId, call.signal)
      }
      // A caller that named its own location is forwarded untouched, so say so
      // in the trace: "no grouping" and "grouping silently skipped" would
      // otherwise look identical from the outside.
      if (call.method === 'session.create' && namesOwnLocation(call.payload)) {
        this.groupingTrace?.(
          'bridge-dsh: session.create 自带 workspaceId/cwd，按调用方位置原样转发（不做分组）',
        )
      }
      const groupedWorkspaceId = call.method === 'session.create' && !namesOwnLocation(call.payload)
        ? await this.grouper?.resolve(call.signal)
        : undefined
      let value: unknown
      try {
        value = await this.gateway.invoke({
          namespace: target.namespace,
          method: target.method,
          args: groupedWorkspaceId === undefined
            ? target.args
            : withWorkspaceId(target.args, groupedWorkspaceId),
          signal: call.signal,
        })
      } catch (error: unknown) {
        // A cached Workspace identity goes stale when the user deletes it in the
        // GUI. Retry the caller's ORIGINAL request exactly once so a stale
        // identity degrades to "ungrouped" instead of failing the Session.
        if (groupedWorkspaceId === undefined || hostFailure(error).code !== WORKSPACE_NOT_FOUND) throw error
        this.grouper?.forget()
        value = await this.gateway.invoke({
          namespace: target.namespace,
          method: target.method,
          args: target.args,
          signal: call.signal,
        })
      }
      // Only claim ownership after a successful create/prompt. A failed prompt
      // against a Desktop session must not steal later ask_user_question away
      // from the native waterfall.
      if (call.method === 'session.create' || call.method === 'session.prompt') {
        this.extensionSessions.note(sessionIdOf(call.payload))
        this.extensionSessions.note(sessionIdOf(value))
        if (typeof value === 'string') this.extensionSessions.note(value)
      }
      return { ok: true, value: target.adapt?.(value) ?? value }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * Switch one session's permission tier by running dsh's own preset command.
   *
   * The write deliberately goes through the command rather than through the
   * bridge appending events: the command records the preset intent alongside
   * the two knobs, so the dsh interface keeps showing which preset is selected
   * and a later switch there cannot resurrect a stale one. Only the target NAME
   * is validated here — whether the switch took effect is decided by the
   * projection feed, never by this response.
   * @param call - the `permission.set` request.
   * @returns an empty success, or a stable failure the panel can act on.
   */
  private async permissionSet(call: HostRpcCall): Promise<HostRpcResult> {
    const payload = call.payload
    if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId === ''
      || typeof payload.preset !== 'string' || payload.preset === '') {
      return {
        ok: false,
        error: { code: 'permission-bad-request', message: 'permission.set requires { sessionId, preset }', details: {} },
      }
    }
    const services = this.permissionServices
    if (services === undefined) {
      return {
        ok: false,
        error: {
          code: PERMISSION_ERROR_CODES.capabilityUnavailable,
          message: 'this dsh deployment exposes no permission tiers',
          details: {},
        },
      }
    }
    if (payload.preset === CUSTOM_PERMISSION_VALUE) {
      return {
        ok: false,
        error: {
          code: PERMISSION_ERROR_CODES.customNotSwitchable,
          message: '"custom" describes settings that match no preset and is not a switch target',
          details: {},
        },
      }
    }
    try {
      // The whitelist check is dsh's own: `/permission` resolves the name
      // against this deployment's preset table and rejects anything else. The
      // bridge cannot improve on that — it has no Session object to read the
      // advertised tiers from, and a built-in list would wrongly refuse a
      // deployment that composes its own presets.
      const value = await this.gateway.invoke({
        namespace: 'commands',
        method: 'execute',
        args: {
          agentId: payload.sessionId,
          line: `/permission ${payload.preset}`,
          submittedAttachments: [],
        },
        signal: call.signal,
      })
      const reported = commandErrorText(value)
      if (reported !== undefined) {
        return {
          ok: false,
          error: {
            code: PERMISSION_ERROR_CODES.unknownPreset,
            message: reported,
            details: {},
          },
        }
      }
      return { ok: true, value: {} }
    } catch (error: unknown) {
      const failure = this.failure(error)
      // A deployment can expose the projection without the command registry
      // that owns the write path. Report that as a missing capability rather
      // than as the generic not-found the gateway would produce.
      if (failure.code === 'not-found' || failure.code === 'gateway/service-unavailable') {
        return {
          ok: false,
          error: {
            code: PERMISSION_ERROR_CODES.capabilityUnavailable,
            message: 'this dsh deployment exposes no permission command',
            details: {},
          },
        }
      }
      return { ok: false, error: failure }
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<HostEventFrame> {
    const generation = new EventGeneration(
      this.followSource,
      this.remoteSource,
      this.resultSender,
      this.extensionSessions,
      this.noteHistoryCursor.bind(this),
      (sessionId) => this.historyCursors.get(sessionId),
      (sessionId) => { this.lastFollowedSessionId = sessionId },
      signal,
    )
    const previous = this.activeEvents
    this.activeEvents = generation
    await previous?.dispose()
    generation.start()
    // Resume the previous connection's Session follow so events emitted while
    // the extension was disconnected keep flowing. Best effort: a dead
    // (e.g. archived) Session must not fail this generation's queue, which
    // would tear down the whole new connection.
    if (this.lastFollowedSessionId !== undefined) {
      void generation.ensureSessionFollow(this.lastFollowedSessionId, signal).catch(() => {})
    }
    try {
      yield * generation.events()
    } finally {
      if (this.activeEvents === generation) this.activeEvents = undefined
      await generation.dispose()
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const generation = this.activeEvents
    if (generation === undefined) return { accepted: false, reason: 'not-pending' }
    return generation.respond(rpcId, result, signal)
  }

  private async sessionHistory(call: HostRpcCall): Promise<HostRpcResult> {
    const sessionId = sessionIdOf(call.payload)
    if (sessionId === undefined) return badRequest('session.history requires a non-empty sessionId')
    let beforeSeq: number | undefined
    let maxMessages: number | undefined
    try {
      beforeSeq = optionalNonNegativeInteger(call.payload, 'beforeSeq')
      maxMessages = optionalPositiveInteger(call.payload, 'maxMessages')
    } catch (error: unknown) {
      return badRequest(error instanceof Error ? error.message : 'session.history pagination is invalid')
    }
    try {
      if (beforeSeq !== undefined) {
        const throughSeq = await this.historyThroughSeq(sessionId, call.signal)
        const page = await this.gateway.invoke({
          namespace: 'session',
          method: 'page',
          args: {
            request: {
              address: { kind: 'session', sessionId },
              throughSeq,
              beforeSeq,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
          },
          signal: call.signal,
        })
        return { ok: true, value: historyPageValue(page) }
      }

      const snapshot = this.activeEvents === undefined
        ? await oneShotSessionSnapshot(this.gateway, sessionId, call.signal, maxMessages)
        : await this.activeEvents.openSessionHistory(sessionId, call.signal, maxMessages)
      this.noteHistoryCursor(sessionId, snapshot.cursor)
      return { ok: true, value: historyValue(snapshot) }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * Resolve a Host-legal throughSeq for older history pages.
   * Never invent Number.MAX_SAFE_INTEGER — session/page rejects tips past the log cursor.
   */
  private async historyThroughSeq(sessionId: string, signal: AbortSignal): Promise<number> {
    const cached = this.historyCursors.get(sessionId)
    if (cached !== undefined) return cached
    const snapshot = this.activeEvents === undefined
      ? await oneShotSessionSnapshot(this.gateway, sessionId, signal)
      : await this.activeEvents.openSessionHistory(sessionId, signal)
    this.noteHistoryCursor(sessionId, snapshot.cursor)
    const throughSeq = this.historyCursors.get(sessionId)
    if (throughSeq === undefined) {
      throw new TypeError('session/follow snapshot did not provide a usable history cursor')
    }
    return throughSeq
  }

  private noteHistoryCursor(sessionId: string, cursor: number): void {
    // Host session/page refuses throughSeq past the durable tip; MAX_SAFE_INTEGER is
    // only a UI sentinel elsewhere and must never be forwarded as a page tip.
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor === Number.MAX_SAFE_INTEGER) return
    const previous = this.historyCursors.get(sessionId)
    if (previous === undefined || cursor > previous) this.historyCursors.set(sessionId, cursor)
  }

  private async workspaceList(call: HostRpcCall): Promise<HostRpcResult> {
    try {
      const controller = new AbortController()
      const signal = AbortSignal.any([call.signal, controller.signal])
      const source = await this.gateway.wireStream.open('workspace/follow', { args: {} }, signal)
      const iterator = source[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        if (first.done || !isWorkspaceBaseline(first.value)) {
          throw new TypeError('workspace/follow did not begin with a baseline')
        }
        return { ok: true, value: first.value.value }
      } finally {
        controller.abort(new Error('workspace baseline received'))
        await iterator.return?.()
      }
    } catch (error: unknown) {
      return { ok: false, error: this.failure(error) }
    }
  }

  /**
   * `model.catalog`: bridge-local, in-process read of the `llm` +
   * `agentDefaultModel` services. Never touches the gateway; a missing
   * service pair fails this call alone — connection, events, and every
   * other RPC are unaffected (spec: 模型目录的提供).
   */
  private async modelCatalog(): Promise<HostRpcResult> {
    if (this.modelServices === undefined) {
      return {
        ok: false,
        error: {
          code: 'llm-unavailable',
          message: '模型目录服务（llm/agentDefaultModel）在本 dsh 部署中不可用',
          details: {},
        },
      }
    }
    try {
      const value = await buildBridgeModelCatalog(this.modelServices)
      return { ok: true, value }
    } catch (error: unknown) {
      return { ok: false, error: hostFailure(error) }
    }
  }

  private failure(error: unknown): HostRpcFailure {
    try {
      return this.gateway.wireStream.failure(error)
    } catch {
      return hostFailure(error)
    }
  }

  private async sendRemoteEventResult(
    clientId: string,
    eventId: string,
    outcome: RemoteEventOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const rpcId = crypto.randomUUID()
    const request = new Request('http://dsh.internal/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: '$events/result',
        payload: { args: { clientId, eventId, outcome } },
      }),
      signal,
    })
    const response = await this.fetchHandler.fetch(request)
    if (!response.ok) {
      throw new Error(`$events/result transport failed with HTTP ${String(response.status)}: ${await response.text()}`)
    }
    const envelope = await response.json() as unknown
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new TypeError('$events/result returned an invalid server-response')
    }
    if (envelope.result.ok) return
    const error = isRecord(envelope.result.error) ? envelope.result.error : {}
    const failure = new Error(typeof error.message === 'string' ? error.message : '$events/result was rejected') as Error & {
      code?: string
      details?: unknown
    }
    if (typeof error.code === 'string') failure.code = error.code
    if (error.details !== undefined) failure.details = error.details
    throw failure
  }
}

function invokeTarget(call: HostRpcCall): InvokeTarget | { readonly error: HostRpcFailure } {
  if (!isRecord(call.payload)) return { error: badRequestFailure(`${call.method} payload must be an object`) }
  switch (call.method) {
    case 'session.list':
      return { namespace: 'session', method: 'list', args: { _request: call.payload } }
    case 'session.create':
    case 'session.selectModel':
    case 'session.attachment':
    case 'session.cancel':
    case 'workspace.create':
    case 'workspace.archiveSession': {
      const [namespace, method] = call.method.split('.') as [string, string]
      return { namespace, method, args: { request: call.payload } }
    }
    case 'session.prompt':
      return {
        namespace: 'session',
        method: 'prompt',
        args: { request: { requestId: call.rpcId, ...call.payload } },
      }
    case 'settings.describe':
      return { namespace: 'settings', method: 'describe', args: {} }
    case 'settings.mutate':
      return { namespace: 'settings', method: 'mutate', args: call.payload }
    case 'credentials.describe':
      return {
        namespace: 'credentials',
        method: 'describe',
        args: call.payload,
        adapt: value => ({ credentials: value }),
      }
    case 'credentials.set':
    case 'credentials.unset': {
      const method = call.method.slice('credentials.'.length)
      return { namespace: 'credentials', method, args: call.payload, adapt: () => ({}) }
    }
    case 'llm.discoverModels': {
      const { settingsNs, ...request } = call.payload
      if (typeof settingsNs !== 'string' || settingsNs.length === 0) {
        return { error: badRequestFailure('llm.discoverModels requires settingsNs') }
      }
      return {
        namespace: 'llm',
        method: 'discoverModels',
        args: { settingsNs, request },
        adapt: value => ({ models: value }),
      }
    }
    case 'commands.list': {
      const sessionId = requireSessionId(call)
      if (typeof sessionId !== 'string') return sessionId
      return { namespace: 'commands', method: 'list', args: { agentId: sessionId } }
    }
    case 'skills.list': {
      // Skills are a namespace parallel to commands, and address the session
      // through a request envelope rather than a resolvable agent id.
      const sessionId = requireSessionId(call)
      if (typeof sessionId !== 'string') return sessionId
      return { namespace: 'skills', method: 'list', args: { request: { sessionId } } }
    }
    case 'commands.execute': {
      const sessionId = requireSessionId(call)
      if (typeof sessionId !== 'string') return sessionId
      // Typed against the shared contract: a rename of `line` on either end
      // becomes a compile error here rather than a bad-request at runtime.
      const line = (call.payload as Partial<CommandExecuteRequest>).line
      if (typeof line !== 'string' || line.trim().length === 0) {
        return { error: badRequestFailure('commands.execute requires a non-empty line') }
      }
      // A panel command never carries attachments, and the host admits an
      // explicit empty array, so the wire shape stays fixed instead of relying
      // on the endpoint's optional-parameter default.
      return {
        namespace: 'commands',
        method: 'execute',
        args: { agentId: sessionId, line, submittedAttachments: [] },
      }
    }
    default:
      return {
        error: {
          code: 'not-found',
          message: `browser bridge Host method ${JSON.stringify(call.method)} is unavailable`,
          details: {},
        },
      }
  }
}

async function oneShotSessionSnapshot(
  gateway: TypertGatewayLike,
  sessionId: string,
  outerSignal: AbortSignal,
  maxMessages?: number,
): Promise<FollowSnapshot> {
  const controller = new AbortController()
  const signal = AbortSignal.any([outerSignal, controller.signal])
  const source = await gateway.wireStream.open(
    'session/follow',
    {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          ...(maxMessages === undefined ? {} : { maxMessages }),
        },
      },
    },
    signal,
  )
  const iterator = source[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || !isSessionSnapshot(first.value)) {
      throw new TypeError('session/follow did not begin with a snapshot')
    }
    return {
      cursor: first.value.cursor,
      records: first.value.records,
      hasMore: first.value.hasMore,
      ...(first.value.projections === undefined ? {} : { projections: first.value.projections }),
    }
  } finally {
    controller.abort(new Error('Session snapshot received'))
    await iterator.return?.()
  }
}

function optionalNonNegativeInteger(
  payload: unknown,
  key: string,
): number | undefined {
  if (!isRecord(payload) || !(key in payload) || payload[key] === undefined) return undefined
  const value = payload[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new TypeError(`${key} must be a non-negative safe integer`)
  }
  return value as number
}

function optionalPositiveInteger(
  payload: unknown,
  key: string,
): number | undefined {
  if (!isRecord(payload) || !(key in payload) || payload[key] === undefined) return undefined
  const value = payload[key]
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${key} must be a positive safe integer`)
  }
  return value as number
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.sessionId !== 'string') return undefined
  // Trimmed, matching the wire parser's own treatment of `tool.call`: a
  // whitespace-only id is not an id, and forwarding it would hand the host an
  // empty lookup key instead of the bad-request it deserves.
  const sessionId = payload.sessionId.trim()
  return sessionId.length > 0 ? sessionId : undefined
}

/**
 * Extract the session a command RPC addresses, or the failure to return.
 * `agentId` is resolved to a live Agent by the host's own lookup provider, so a
 * blank id must fail here rather than reach the gateway as an empty lookup key.
 * @param call - the decoded command RPC.
 * @returns the session id, or the wrapped bad-request failure to hand back verbatim.
 */
function requireSessionId(call: HostRpcCall): string | { readonly error: HostRpcFailure } {
  const sessionId = sessionIdOf(call.payload)
  return sessionId ?? { error: badRequestFailure(`${call.method} requires a non-empty sessionId`) }
}

function namesOwnLocation(payload: unknown): boolean {
  if (!isRecord(payload)) return true
  return payload.workspaceId !== undefined || payload.cwd !== undefined
}

/**
 * Copy a `session.create` arg bag with the resolved Workspace injected.
 * @param args - the original forwarded args.
 * @param workspaceId - Workspace that should own the new Session.
 * @returns a new arg bag; the input is left unmodified.
 */
function withWorkspaceId(
  args: Readonly<Record<string, unknown>>,
  workspaceId: string,
): Readonly<Record<string, unknown>> {
  const request = args.request
  if (!isRecord(request)) return args
  return { ...args, request: { ...request, workspaceId } }
}

function badRequest(message: string): HostRpcResult {
  return { ok: false, error: badRequestFailure(message) }
}

function badRequestFailure(message: string): HostRpcFailure {
  return { code: 'bad-request', message, details: {} }
}

function isWorkspaceBaseline(value: unknown): value is {
  readonly type: 'baseline'
  readonly value: Record<string, unknown>
} {
  return isRecord(value) && value.type === 'baseline' && isRecord(value.value)
}

function isRemoteEventReady(value: unknown): value is {
  readonly type: 'ready'
  readonly clientId: string
} {
  return isRecord(value) && value.type === 'ready'
    && typeof value.clientId === 'string' && value.clientId.length > 0
}
