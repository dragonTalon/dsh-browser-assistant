/**
 * Workspace grouping for extension-created Sessions: registers the configured
 * directory as a dsh Workspace and injects the resolved identity into
 * `session.create` requests.
 *
 * Host-agnostic: it depends only on the `HostInvoker` primitive plus the
 * deployment's warn/trace sinks, so a dsh version change touches the adapter,
 * not this module. The lifetime semantics are deliberate and unchanged from
 * the pre-split code: the registration runs on the bridge's own lifetime (a
 * caller that goes away cannot leave the next Session's grouping undecided),
 * while only the CALLER's wait is bounded by the caller's signal.
 *
 * @module
 */

import { hostFailure, isRecord, type HostRpcFailure } from './host-api.ts'
import type { HostInvoker } from './host-streams.ts'

/** Deployment inputs for placing extension-created Sessions in a Workspace. */
export interface WorkspaceGrouperOptions {
  /** The HostInvoker primitive registration calls go through. */
  readonly host: HostInvoker
  /** Absolute directory whose Workspace owns extension-created Sessions. */
  readonly workspacePath?: string
  /** Sink for non-fatal grouping diagnostics; absent → silent. */
  readonly warn?: (message: string) => void
  /**
   * Sink for the resolution trace: one line when a `session.create` asks for
   * the grouped Workspace, and one line per distinct registration attempt with
   * its outcome. Grouping is a silent enhancement by design, so without this
   * trace a Session that lands in "ungrouped" leaves no evidence of whether the
   * bridge tried to register, reused a cached id, or skipped the caller.
   */
  readonly trace?: (message: string) => void
  /**
   * Attempts one `session.create` may spend registering the Workspace before it
   * gives up and starts the Session ungrouped. Defaults to
   * {@link DEFAULT_REGISTRATION_ATTEMPTS}; 1 restores "one attempt per call".
   */
  readonly registrationAttempts?: number
  /**
   * Wait between attempts, in ms. Defaults to
   * {@link DEFAULT_REGISTRATION_RETRY_DELAY_MS}; 0 keeps a behavior check
   * deterministic instead of making it sleep.
   */
  readonly registrationRetryDelayMs?: number
}

/** Registration attempts one `session.create` may spend. */
export const DEFAULT_REGISTRATION_ATTEMPTS = 2

/** Wait between two registration attempts (ms). */
export const DEFAULT_REGISTRATION_RETRY_DELAY_MS = 150

/**
 * dsh error codes that mean "this attempt failed, a later one may not". A
 * missing directory (`workspace/invalid-path`) or a rejected request
 * (`gateway/bad-request`) is permanent: repeating it cannot change the answer,
 * so those fail fast instead of spending the caller's session on a retry.
 */
const TRANSIENT_REGISTRATION_CODES = new Set([
  'gateway/service-unavailable',
  'gateway/timeout',
  'timeout',
  'aborted',
  'cancelled',
  'internal',
])

/**
 * Whether a failed registration is worth one more attempt.
 *
 * An aborted bridge lifetime is transient by definition — the bridge replaces
 * its lifetime when a connection generation is torn down — and a create whose
 * answer was lost (internal carrier failure) may well have succeeded host-side,
 * so the retry doubles as a read-back of the same idempotent call.
 * @param code - the failure code reported for the attempt.
 * @param signal - the registration's own signal.
 * @returns true when another attempt is allowed.
 */
function isTransientRegistrationFailure(code: string, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return TRANSIENT_REGISTRATION_CODES.has(code)
}

/** Sleep, used only between two registration attempts. */
async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Read `workspace.workspaceId` out of a `workspace.create` value. */
function workspaceIdOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const workspace = value.workspace
  if (!isRecord(workspace)) return undefined
  const workspaceId = workspace.workspaceId
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : undefined
}

/**
 * Resolves the Workspace that should own an extension-created Session.
 *
 * Registration is idempotent, so an already-registered directory resolves to
 * its existing identity without writing. Only a SUCCESS is cached: a failed
 * resolution must be retried by the next `session.create`, otherwise a
 * transiently missing directory would pin the bridge to "ungrouped".
 */
export class WorkspaceGrouper {
  private groupedWorkspaceId: string | undefined
  /** In-flight registration so concurrent creates share one `workspace.create`. */
  private groupedWorkspacePending: Promise<string | undefined> | undefined
  /**
   * Owns the lifetime of in-flight registration. It deliberately does NOT
   * borrow the requesting connection's signal: that connection is replaced on
   * every extension reconnect, and a signal captured into the shared
   * registration path would kill every later attempt too — silently turning
   * grouping off for the rest of the process. Only the wait is the caller's;
   * the registration itself is the bridge's.
   */
  private readonly groupedWorkspaceAbort = new AbortController()

  constructor(private readonly options: WorkspaceGrouperOptions) {}

  /**
   * Drop the cached identity so the next `session.create` re-registers.
   * Used when a cached Workspace identity goes stale (deleted in the GUI).
   */
  forget(): void {
    this.groupedWorkspaceId = undefined
  }

  /**
   * Resolve the Workspace identity for one `session.create`.
   *
   * The caller's signal bounds only how long THIS caller waits. The shared
   * registration runs on the bridge's own lifetime and keeps its result, so a
   * reconnect mid-registration cannot disable grouping for later callers.
   * @param signal - the caller's RPC signal, used for the wait alone.
   * @returns the Workspace id, or undefined when grouping is off or failed.
   */
  async resolve(signal: AbortSignal): Promise<string | undefined> {
    const path = this.options.workspacePath
    if (path === undefined) return undefined
    if (this.groupedWorkspaceId !== undefined) {
      this.options.trace?.(
        `bridge-dsh: session.create 复用已解析工作区 ${this.groupedWorkspaceId}（${path}）`,
      )
      return this.groupedWorkspaceId
    }
    // A caller that is already gone cannot use a Session, so this call declines
    // to START a registration. That is deliberate and bounded: registration is
    // never tied to a caller's signal, so a registration already in flight keeps
    // running on the bridge's own lifetime and the NEXT session.create picks up
    // its result. The line exists so a declined call is distinguishable from one
    // that never arrived at all.
    if (signal.aborted) {
      this.options.trace?.(
        `bridge-dsh: session.create 到达时调用方已取消，跳过工作区 ${path} 的注册（会话不会分组）`,
      )
      return undefined
    }
    if (this.groupedWorkspacePending === undefined) {
      this.groupedWorkspacePending = this.register(path, this.groupedWorkspaceAbort.signal)
        .finally(() => { this.groupedWorkspacePending = undefined })
    }
    const pending = this.groupedWorkspacePending
    let cancelWait = (): void => {}
    const aborted = new Promise<undefined>((resolve) => {
      cancelWait = () => { resolve(undefined) }
      signal.addEventListener('abort', cancelWait, { once: true })
    })
    try {
      return await Promise.race([pending, aborted])
    } finally {
      signal.removeEventListener('abort', cancelWait)
    }
  }

  /**
   * Register the configured directory as a Workspace and read back its id.
   *
   * The contract this serves is "the Workspace exists BEFORE the Session": the
   * caller holds `session.create` until this settles, so a registration that
   * fails transiently — an aborted or unavailable gateway call, a create whose
   * answer was lost — would otherwise start a Session that can never be grouped
   * (dsh's only adoption path requires the Session header's cwd to equal the
   * Workspace path, and the bridge cannot migrate a Session afterwards).
   *
   * A transient failure is therefore retried inside this same call. A permanent
   * one (a path that does not exist, a rejected identity) is not: repeating it
   * cannot change the answer. Every outcome is reported through `trace`/`warn`,
   * so a Session that still lands ungrouped says why.
   *
   * Unlike {@link resolve}, this never consults a caller: the attempt runs on
   * the bridge's own lifetime, so a caller that goes away mid-registration
   * cannot leave the next Session's grouping undecided.
   */
  private async register(path: string, signal: AbortSignal): Promise<string | undefined> {
    const attempts = Math.max(1, this.options.registrationAttempts ?? DEFAULT_REGISTRATION_ATTEMPTS)
    let failure: HostRpcFailure | undefined
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.options.trace?.(
        attempt === 1
          ? `bridge-dsh: 正在把 ${path} 注册为 dsh 工作区…`
          : `bridge-dsh: 第 ${attempt}/${attempts} 次重试注册工作区 ${path}…`,
      )
      try {
        const value = await this.options.host.invoke('workspace', 'create', { request: { path } }, signal)
        const workspaceId = workspaceIdOf(value)
        if (workspaceId === undefined) {
          throw new TypeError('workspace.create did not return workspace.workspaceId')
        }
        this.groupedWorkspaceId = workspaceId
        this.options.trace?.(
          `bridge-dsh: 工作区已解析 workspaceId=${workspaceId}（${path}），后续会话复用该身份`,
        )
        return workspaceId
      } catch (error: unknown) {
        this.groupedWorkspaceId = undefined
        failure = hostFailure(error)
        if (!isTransientRegistrationFailure(failure.code, signal) || attempt === attempts) break
        await delay(this.options.registrationRetryDelayMs ?? DEFAULT_REGISTRATION_RETRY_DELAY_MS)
      }
    }
    const reported = failure ?? hostFailure(new Error('workspace.create failed without an error'))
    const hint = signal.aborted
      ? '（注册所用的桥生命周期已被中止；下一次 session.create 会重新尝试）'
      : ''
    this.options.warn?.(
      `bridge-dsh: sessionWorkspace ${JSON.stringify(path)} 注册失败（${reported.code}: ${reported.message}）`
      + `${hint}，本次会话将不分组`,
    )
    return undefined
  }
}
