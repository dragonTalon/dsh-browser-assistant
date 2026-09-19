/**
 * `bridge-dsh`: token-authenticated WebSocket bridge for the
 * browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). Extension
 * calls and Host waterfalls use dsh's Typert Gateway + Connection services
 * (0.1.2 / 0.1.3-alpha architecture). Tools execute by dispatching
 * `tool.call` frames to the connected extension, which performs the action in
 * the tab explicitly controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module bridge-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { BridgeServer } from './server.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  BRIDGE_SESSION_PERMISSION_EVENT,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from '@dsh-browser/protocol'
import { resolveToken } from './token.ts'
import { createPermissionServices, type PermissionServices } from './permission.ts'
import { watchPermissionTiers } from './permission-watch.ts'
import { registerTierNarration, type SystemPromptLike } from './tier-narration.ts'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from './remote-host-api.ts'
import type { AgentDefaultModelLike, LlmLike } from './model-catalog.ts'
import { isRecord } from './host-api.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-dsh'

/** Services required by this plugin. */
export const inject = ['webServer', 'typertGateway', 'connection', 'tools']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
  /**
   * Absolute directory whose dsh Workspace owns Sessions the extension creates.
   * When absent (or blank), extension Sessions keep dsh's own default placement.
   */
  sessionWorkspace?: string
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspace: z.string(),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token' | 'sessionWorkspace'>>
  & Pick<Config, 'token' | 'sessionWorkspace'>

/**
 * Normalize the configured Session Workspace directory: an absent, empty, or
 * whitespace-only setting means "not configured" and must stay inert.
 * @param value - raw config value.
 * @returns the configured directory, or undefined when the feature is off.
 */
export function normalizeSessionWorkspace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bridge-dsh: ${name} must be a positive integer`)
  }
}

export function resolveConfig(config: Config): ResolvedConfig {
  const sessionWorkspace = normalizeSessionWorkspace(config.sessionWorkspace)
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    ...(sessionWorkspace === undefined ? {} : { sessionWorkspace }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-dsh: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route and the
 * tool set, all effect-scoped for HMR.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const tokenRes = await resolveToken(resolved.token)

  const gateway = ctx.get('typertGateway') as unknown as TypertGatewayLike | undefined
  const connection = ctx.get('connection') as unknown as HostConnectionLike | undefined
  if (gateway === undefined) throw new Error('bridge-dsh: dsh typertGateway service is required')
  if (connection === undefined) throw new Error('bridge-dsh: dsh connection service is required')
  await ensureRemoteEventSource(ctx, gateway)

  // Optional model-catalog services: probed (never injected), so an older dsh
  // missing either service still boots the bridge — `model.catalog` then
  // fails cleanly as `llm-unavailable` (design D1).
  const llm = ctx.get('llm') as unknown as LlmLike | undefined
  const agentDefaultModel = ctx.get('agentDefaultModel') as unknown as AgentDefaultModelLike | undefined
  const modelServices = llm !== undefined && agentDefaultModel !== undefined
    ? { llm, agentDefaultModel }
    : undefined
  if (modelServices === undefined) {
    ctx.logger.warn('bridge-dsh: llm/agentDefaultModel 服务未探测到，model.catalog 将返回 llm-unavailable')
  }

  // Optional permission tiers: probed for the same reason. Without the
  // projection registry the bridge cannot even learn the deployment's preset
  // table, so it reports no tier capability — calls carry no policy and the
  // extension keeps its pre-tier, always-confirm behavior. The registry is NOT
  // the tier's source of truth (the session's own knob events are); it supplies
  // the preset names and the cross-check.
  const permissionServices = createPermissionServices(ctx, (message) => { ctx.logger.warn(message) })
  if (permissionServices === undefined) {
    ctx.logger.warn('bridge-dsh: sessionProjections 服务未探测到，权限档位将整体降级为无档位')
  }

  const sessionGrouping = resolved.sessionWorkspace === undefined
    ? undefined
    : {
        workspacePath: resolved.sessionWorkspace,
        // Grouping is an enhancement: a misconfigured directory must stay
        // diagnosable without ever failing Session creation.
        warn: (message: string) => { ctx.logger.warn(message) },
        // The resolution trace answers "why did this Session land ungrouped?"
        // without a debugger: enabled grouping says so once at mount, and every
        // create reports reuse, registration, or a declined/aborted caller.
        trace: (message: string) => { ctx.logger.info(message) },
      }
  if (sessionGrouping !== undefined) {
    ctx.logger.info(
      `bridge-dsh: 会话分组已启用，扩展创建的会话将归入工作区 ${resolved.sessionWorkspace}`,
    )
  }

  mountBridge(ctx, resolved, tokenRes, createRemoteHostApi(
    gateway,
    connection,
    modelServices,
    sessionGrouping,
    permissionServices,
  ), permissionServices)
}

function mountBridge(
  ctx: Context,
  resolved: ResolvedConfig,
  tokenRes: Awaited<ReturnType<typeof resolveToken>>,
  api: ReturnType<typeof createRemoteHostApi>,
  permissionServices: PermissionServices | undefined,
): void {
  const server = new BridgeServer({
    token: tokenRes.token,
    api,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-dsh: /ext/bridge upgrade route')
  ctx.effect(() => () => server.close(), 'bridge-dsh: bridge server')

  // Zero-config discovery endpoint: the extension fetches this to learn the
  // bridge WebSocket URL without any manual configuration.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-dsh: /ext/bridge-config route')

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
      ...(permissionServices === undefined ? {} : { permissions: permissionServices }),
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-dsh: browser tools')

  // Tier changes are pushed and acted on only when a tier actually moves: the
  // watcher compares values, so a refused or no-op switch request has no effect.
  // It rides the session append feed — the very log the tier is folded from —
  // so the announced tier and the enforced tier come from one computation.
  if (permissionServices !== undefined) {
    const watcher = watchPermissionTiers({
      permissions: permissionServices,
      announce: (sessionId, value) => {
        server.publishEvent(BRIDGE_SESSION_PERMISSION_EVENT, { sessionId, value })
      },
      withdraw: (sessionId) => server.cancelPendingForSession(sessionId),
      log: (message) => { ctx.logger.warn(message) },
    })
    ctx.effect(
      () => ctx.on('session/event', (session: unknown, event: unknown) => { watcher(session, event) }),
      'bridge-dsh: permission tier watch',
    )
    // The host service is probed, never injected: without it the deployment
    // gets no narration, and nothing else about the bridge changes.
    registerTierNarration({
      systemPrompt: ctx.get('systemPrompt') as SystemPromptLike | undefined,
      permissions: permissionServices,
      effect: (register, name) => { ctx.effect(register, name) },
    })
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600)`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}

/**
 * Workaround for a profile that lists api-remotes but can leave its `$events`
 * source unregistered. Probe the stream; apply api-remotes when missing.
 */
async function ensureRemoteEventSource(ctx: Context, gateway: TypertGatewayLike): Promise<void> {
  const controller = new AbortController()
  let iterator: AsyncIterator<unknown> | undefined
  try {
    const source = await gateway.wireStream.open('$events', { args: {} }, controller.signal)
    iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (!first.done && isRecord(first.value) && first.value.type === 'ready') return
    throw new TypeError('dsh $events stream did not begin with a ready frame')
  } catch (error: unknown) {
    const failure = gateway.wireStream.failure(error)
    if (failure.code !== 'gateway/service-unavailable') throw error
  } finally {
    controller.abort(new Error('dsh $events readiness probe completed'))
    await iterator?.return?.()
  }

  const remoteAssembly = await import('@deepseek-ai/dsh-api-remotes')
  remoteAssembly.apply(ctx)
}
