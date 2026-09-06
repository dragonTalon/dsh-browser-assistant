/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@dsh-browser/protocol'
import type { ToolError } from '@dsh-browser/protocol'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { approvalPromptForCall } from './authorization.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_wait',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_open_tab',
])
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

/** Whether a successful tool may have changed the controlled tab's page URL. */
export function isNavigationCandidateTool(name: string): boolean {
  return NAVIGATION_CANDIDATE_TOOLS.has(name)
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
function approvalFailure(approval: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  switch (authorization) {
    case 'denied':
      return {
        ok: false,
        error: { code: 'action-failed', message: `The user denied the browser approval request for "${approval.action}".` },
      }
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'action-failed',
          message: `No browser side panel was available to receive or complete the approval request for "${approval.action}".`,
        },
      }
    case 'timed-out':
      return {
        ok: false,
        error: { code: 'timeout', message: `The browser approval request for "${approval.action}" timed out before the user responded.` },
      }
    case 'cancelled':
      return {
        ok: false,
        error: { code: 'bridge-closed', message: `The browser approval request for "${approval.action}" was cancelled.` },
      }
  }
}

function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

async function snapshotAllFrames(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  const budgets = allocateFrameBudgets(frames, budget)
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    if (frame.frameId === 0) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  snapshotDocumentsByTab.set(tabId, capturedDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  if (snapshotMaxChars < 500) return undefined
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const navigationWait = includeActionDelta && isNavigationCandidateTool(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  try {
    response = await sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
    )
  } catch (error: unknown) {
    navigationWait?.cancel()
    throw error
  }
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    return unavailable('The page content script returned an invalid response.')
  }
  const text = answerText(response)
  if (text === undefined) {
    navigationWait?.cancel()
    return response
  }
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    const ready = await navigationWait.ready
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  const pageContent = requestPageDelta ? answerPageContent(response) : undefined
  return {
    ok: true,
    result: {
      text: pageContent === undefined ? text : wrapActionDelta(text, pageContent, frame, budget.maxChars),
    },
  }
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url'>,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer> {
  if (call.name === 'browser_open_tab') {
    return unavailable('browser_open_tab must be dispatched through the background open-tab path.')
  }
  if (isCancelled(call, signal)) return cancelled()
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (sharePageContent === 'off' && (call.name === 'browser_snapshot' || call.name === 'browser_get_text')) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const approval = approvalPromptForCall(call, sharePageContent, frames)
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    const refreshedApproval = approvalPromptForCall(call, sharePageContent, executionFrames)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      sharePageContent === 'auto',
    )
  } catch {
    if (isCancelled(call, signal)) return cancelled()
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    if (!isInjectablePage(tab.url)) {
      return unavailable('The current page does not support browser operations. Switch to a standard http or https page.')
    }
    try {
      await injectContentScript(tab.id)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      if (approval !== undefined) {
        const refreshedApproval = approvalPromptForCall(call, sharePageContent, refreshedFrames)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        sharePageContent === 'auto',
      )
    } catch {
      return unavailable('The content script could not be loaded on this page. Chrome internal and protected pages do not support browser operations.')
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name !== 'browser_click' && call.name !== 'browser_type') return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  return undefined
}

function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}

/** Parse a model-supplied http(s) URL for tab creation / navigation. */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

async function removeCreatedTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // The tab may already have been closed by the user or another tool.
  }
}

/**
 * Open a URL in a new tab, then optionally snapshot it once the document is ready.
 * Affinity rebinding is owned by the caller via `bindCreatedTab`.
 *
 * Creates a blank tab first, arms the readiness listener, then navigates so a
 * fast `document_idle` cannot announce readiness before the listener exists.
 * Cancellation before affinity bind rolls the orphan tab back; after bind the
 * open is treated as committed and reported as success even if the call expires.
 */
export async function dispatchOpenTab(
  call: ToolCall,
  windowId: number,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget: ContentBudget | undefined,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  bindCreatedTab: (tab: chrome.tabs.Tab) => boolean,
  targetStillAllowed: (tabId: number) => boolean,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  const parsed = parseHttpUrl(call.args.url)
  if (parsed === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
  }

  const approval = approvalPromptForCall(call, sharePageContent, [])
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
  }

  let created: chrome.tabs.Tab
  try {
    // No URL yet: register the readiness wait before the http(s) navigation.
    created = await chrome.tabs.create({ active: true, windowId })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to open a new browser tab.',
      },
    }
  }
  if (created.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome created a tab without an id.' } }
  }
  const tabId = created.id
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }

  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, signal)
  try {
    created = await chrome.tabs.update(tabId, { url: parsed.href })
  } catch (error: unknown) {
    navigationWait.cancel()
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to navigate the new browser tab.',
      },
    }
  }

  const ready = await navigationWait.ready
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }
  if (!bindCreatedTab(created.id === undefined ? { ...created, id: tabId } : created)) {
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The new tab could not become the controlled browser target.' },
    }
  }

  // Affinity is committed: further cancellation must not claim the tab was never opened.
  resetTabSnapshot(tabId)
  if (!targetStillAllowed(tabId)) return targetChanged()

  const status = `Opened a new tab at ${parsed.href}.`
  if (!ready || sharePageContent === 'off' || isCancelled(call, signal)) {
    return {
      ok: true,
      result: {
        text: sharePageContent === 'off'
          ? `${status} Page content sharing is disabled, so no snapshot was captured.`
          : `${status} Call browser_snapshot again after the page loads.`,
      },
    }
  }

  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      status,
      budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS },
      () => targetStillAllowed(tabId),
    )
    if (snapshot !== undefined) return snapshot
  } catch {
    // Keep the successful open when the replacement page is not yet readable.
  }
  return {
    ok: true,
    result: { text: `${status} Call browser_snapshot again after the page loads.` },
  }
}
