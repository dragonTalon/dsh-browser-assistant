/**
 * Slash-command menu: the session's slash vocabulary — host commands AND
 * user-invocable skills — and the `/`-triggered overlay that turns a name into
 * a submittable line.
 *
 * dsh has two parallel slash namespaces, and the web client's own menu merges
 * them:
 *
 * - **Commands** (`commands.list`, `commands.execute`) run a host handler and
 *   open no turn.
 * - **Skills** (`skills.list`) have no execute endpoint at all. They are
 *   invoked by sending `/<name>` as an ordinary prompt, which the host's
 *   pre-step boundary recognizes as a load gesture and answers by injecting the
 *   skill body. That is exactly what the panel's normal send path already does,
 *   so a skill needs no second mechanism here.
 *
 * The merge follows the host's own adjudication: when both namespaces publish
 * the same name, the **command wins** — a line shared by the two resolves to
 * the command, which is why a line is routed by which namespace it came from.
 *
 * The panel deliberately does NOT judge which entries it can "carry". An
 * earlier revision kept an allowlist of argument-less commands, on the theory
 * that the panel cannot present a command needing input. That inverted the
 * actual truth: the host owns each command's grammar and answers for it
 * (`/goal clear`, `/permission workspace-write`, `/plan off` are all the
 * documented forms), the panel is a plain textarea that can type an argument as
 * easily as a chat message, and the catalog's optional input hint cannot
 * distinguish a required argument from an optional one anyway. The allowlist
 * therefore blocked most of the useful surface while protecting nothing.
 *
 * The catalog is per-session (the host resolves both namespaces against one
 * session), so the cache is keyed by the bound session and a response for a
 * session the panel has since left is dropped rather than stored.
 *
 * Session identity is NOT stored here. `conversation.ts` owns it and already
 * answers `isBound()`; a second copy kept in step by notifications has no
 * recovery path if one is missed.
 *
 * DOM elements are injected by `initSlashCommand` rather than looked up at
 * module evaluation. Reading `document` on import made this module impossible
 * to load outside a browser, which is exactly what kept every pure rule below
 * (merge, readCatalog, queryOf, matches, submittedSlashName) out of reach of
 * the repo's own offline checks.
 *
 * @module
 */

import {
  BRIDGE_COMMANDS_LIST_METHOD,
  BRIDGE_SKILLS_LIST_METHOD,
  type CommandDescriptorWire,
  type SkillSummaryWire,
} from '@dsh-browser/protocol'
import { rpc } from './transport.ts'
import { el, errorCode } from '../common/index.ts'
import {
  isComposingKey,
  matches,
  merge,
  queryOf,
  readCatalog,
  type SlashEntry,
  type SlashKind,
} from '../common/slash-catalog.ts'
import { ensureSession, getActiveSessionId, isBound } from './conversation.ts'
import * as text from './slash-command-text.ts'

/** The composer elements this module drives, injected at init. */
export interface SlashCommandElements {
  /** The overlay container. */
  readonly menu: HTMLElement
  /** The composer textarea. */
  readonly input: HTMLTextAreaElement
}

/** Catalog load state for the bound session. */
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'failed'

let menuEl: HTMLElement | null = null
let inputEl: HTMLTextAreaElement | null = null

/** Session the cached `entries` belong to; null means the cache is not usable. */
let catalogSessionId: string | null = null
let connected = false
let entries: readonly SlashEntry[] = []
let status: CatalogStatus = 'idle'
/** In-flight request, so concurrent callers for one session share a single read. */
let pending: Promise<void> | null = null
/** Session the in-flight request was issued for; also the coalescing key. */
let pendingSessionId: string | null = null
/** Bumped on every context change, so a late response is never applied across it. */
let generation = 0
/** Set after a failed command read so its cause can follow the next submit attempt. */
let failure: string | null = null
/** Whether the overlay is currently shown. */
let open = false
/** True while the menu is creating the session it needs to resolve commands. */
let creating = false
/** True once the menu has tried to create that session, so a failure is not retried forever. */
let createFailed = false

/** Index into `entries` of the highlighted row, or -1 when nothing is selectable. */
let highlight = -1
/** Rendered rows in display order, each carrying its catalog index. */
let rows: { readonly el: HTMLElement; readonly index: number }[] = []
/** Selection callback, bound once by `initSlashCommand`. */
let onPick: (() => void) | null = null

/** Human-readable reason a catalog read failed. */
function describeCatalogFailure(error: unknown): string {
  const code = errorCode(error)
  return text.catalogFailure(code, error instanceof Error ? error.message : String(error))
}

/**
 * Refresh the catalog for the bound session.
 *
 * A read is coalesced only with another read for THE SAME session: two sessions
 * are two different catalogs, so sharing one request between them would leave
 * the newly bound session with no request of its own.
 *
 * @returns a promise settling after the attempt, never rejecting.
 */
export async function refreshCatalog(): Promise<void> {
  const sessionId = getActiveSessionId()
  if (!connected || sessionId === null) return
  if (pending !== null && pendingSessionId === sessionId) return pending
  const requested = sessionId
  // Captured so a response that outlives a session switch or a reconnect is
  // dropped instead of being adopted as the current catalog.
  const issued = generation
  status = 'loading'
  renderMenu()
  pendingSessionId = requested
  pending = (async () => {
    try {
      // The command catalog decides whether the menu is usable at all, so it
      // alone governs the status. The skill catalog is supplementary: a
      // deployment may mount no skill registry, and losing skills must never
      // cost the user their commands.
      const [commands, skills] = await Promise.all([
        rpc<unknown>(BRIDGE_COMMANDS_LIST_METHOD, { sessionId: requested }),
        rpc<unknown>(BRIDGE_SKILLS_LIST_METHOD, { sessionId: requested }).catch(() => undefined),
      ])
      // The panel may have switched sessions or reconnected while this read was
      // in flight; a stale catalog must not become the current menu.
      if (generation !== issued || getActiveSessionId() !== requested) return
      entries = merge(readCatalog(commands, 'command'), readCatalog(skills, 'skill', 'skills'))
      catalogSessionId = requested
      status = 'ready'
      failure = null
    } catch (error: unknown) {
      if (generation !== issued || getActiveSessionId() !== requested) return
      entries = []
      catalogSessionId = null
      status = 'failed'
      failure = describeCatalogFailure(error)
    } finally {
      if (pendingSessionId === requested) {
        pending = null
        pendingSessionId = null
      }
      renderMenu()
    }
  })()
  return pending
}

/**
 * Hand over a failed catalog read once, so the submit path can report why the
 * text was not sent instead of leaving the user with a silent no-op.
 * @returns the failure text, or null when the last read succeeded.
 */
export function takeFailure(): string | null {
  const message = failure
  failure = null
  return message
}

/** Whether the command catalog for the bound session is loaded and usable. */
export function catalogReady(): boolean {
  return status === 'ready' && catalogSessionId === getActiveSessionId()
}

/**
 * Resolve one submitted name against the bound session's merged catalog.
 * @param name - name without the leading slash.
 * @returns the entry, or undefined when neither namespace resolves the name
 *   (an unknown name is ordinary text, not a failed command).
 */
export function resolveSlashEntry(name: string): SlashEntry | undefined {
  if (!catalogReady()) return undefined
  return entries.find((entry) => entry.name === name)
}

/**
 * Follow the panel's connection state. A disconnect invalidates the catalog —
 * the entries named a host this panel can no longer reach — so the next read
 * starts from nothing rather than serving a stale host's commands.
 * @param next - the bridge connection state.
 */
export function setContext(next: { connected?: boolean }): void {
  if (next.connected !== undefined && next.connected !== connected) {
    connected = next.connected
    if (!connected) invalidate()
  }
}

/**
 * Drop the cached catalog. Called whenever the session identity or the
 * connection makes the existing entries unusable.
 */
export function invalidate(): void {
  generation += 1
  entries = []
  catalogSessionId = null
  status = 'idle'
  failure = null
  // A different session is a different attempt: a previous creation failure
  // must not keep the menu from trying again for this one.
  createFailed = false
  closeMenu()
}

/**
 * Bind the composer behaviours: catalog re-reads on keystrokes, keyboard
 * navigation, click selection, and dismissal on an outside click.
 * @param elements - the composer elements this module drives.
 * @param pick - called after a selection wrote a line into the composer.
 */
export function initSlashCommand(elements: SlashCommandElements, pick: () => void): void {
  menuEl = elements.menu
  inputEl = elements.input
  onPick = pick
  // The overlay's accessible name is authored here rather than in the static
  // HTML so it follows the same language resolution as every other panel string.
  menuEl.setAttribute('aria-label', text.menuLabel())
  inputEl.addEventListener('input', () => { void onInput() })
  inputEl.addEventListener('keydown', (event) => { handleKeydown(event) })
  // A pointer that lands outside the composer dismisses the overlay; a click on
  // a row settles after this listener, so the row still sees its own click.
  document.addEventListener('pointerdown', (event) => {
    if (!open) return
    const target = event.target
    if (target instanceof Node && (menuEl?.contains(target) === true || inputEl === target)) return
    closeMenu()
  })
}

/** Re-read the catalog on first use, then render for the current draft. */
async function onInput(): Promise<void> {
  if (queryOf(inputEl?.value ?? '') === undefined) {
    closeMenu()
    return
  }
  // A command catalog is resolved against a session, so the "new session" state
  // has nothing to ask about. Opening the menu is the user asking, so this is
  // where the panel creates the session it will resolve against — the state is
  // exited by the interaction that needs it rather than by a separate ceremony.
  if (!isBound() && !creating && !createFailed) {
    creating = true
    renderMenu()
    try {
      // ensureSession() binds what it creates, and the binding listener points
      // this module at it; a failure reports itself in the transcript.
      const created = await ensureSession()
      if (!created) createFailed = true
      void refreshCatalog()
    } finally {
      creating = false
      renderMenu()
    }
    return
  }
  if (status === 'idle') await refreshCatalog()
  renderMenu()
}

/** The `/`-prefix filter text, or undefined when the draft is not a name draft. */

/**
 * Rebuild the overlay for the current draft. Called on every keystroke, so it
 * must be cheap and must never move focus (that would close the menu).
 *
 * An empty result is never silent: there are four distinct reasons the menu can
 * offer nothing, and each one gets its own inert row. A blank menu would be
 * indistinguishable from "the panel knows no commands", which is the one
 * conclusion that is always wrong.
 */
export function renderMenu(): void {
  if (menuEl === null || inputEl === null) return
  const query = queryOf(inputEl.value)
  if (query === undefined) {
    closeMenu()
    return
  }
  if (!connected) {
    // No bridge means no catalog and no session to resolve one against, so the
    // menu names that rather than promising a session it cannot start.
    showPlaceholder(text.menuUnavailable())
    return
  }
  if (!isBound()) {
    // The panel creates the session this keystroke needs. A failed attempt says
    // so instead of promising a session that is not coming; a successful one
    // binds, and the binding listener re-renders with the real catalog.
    showPlaceholder(createFailed ? text.menuUnavailable() : text.menuCreatingSession())
    return
  }
  if (status === 'idle' || status === 'loading') {
    showPlaceholder(text.menuLoading())
    return
  }
  if (status === 'failed') {
    showPlaceholder(text.menuUnavailable())
    return
  }
  const visible = matches(query, entries)
  if (visible.length === 0) {
    showPlaceholder(text.menuNoMatch())
    return
  }
  menuEl.textContent = ''
  rows = []
  highlight = -1
  for (const entry of visible) {
    const index = entries.indexOf(entry)
    const row = buildRow(entry, index)
    rows.push({ el: row, index })
    menuEl.appendChild(row)
    if (highlight === -1) highlight = index
  }
  open = true
  menuEl.classList.add('open')
  paintHighlight()
}

/** Open the overlay holding one inert explanatory row. */
function showPlaceholder(label: string): void {
  if (menuEl === null) return
  menuEl.textContent = ''
  rows = []
  highlight = -1
  menuEl.appendChild(el('div', { class: 'slashItem slashHint', text: label }))
  open = true
  menuEl.classList.add('open')
}

/**
 * Build one menu row. The label carries the name plus the host's own argument
 * hint when it published one (commands only — a skill's name is the whole
 * gesture), so the documented argument forms are visible at the point of
 * choosing rather than only in the description.
 */
function buildRow(entry: SlashEntry, index: number): HTMLElement {
  const name = entry.hint === undefined ? `/${entry.name}` : `/${entry.name} ${entry.hint}`
  // A skill the model cannot invoke itself is the user's to type, which is
  // worth saying here — it is the one flag the skill catalog publishes.
  const label = entry.modelInvocable === false ? `${name} · ${text.userOnlyMarker()}` : name
  return el('div', {
    class: 'slashItem',
    // Text nodes only: a host description is data and must never become markup.
    children: [
      el('span', { class: 'slashName', text: label }),
      el('span', { class: 'slashDesc', text: entry.description ?? '' }),
    ],
    onClick: () => { choose(index) },
  })
}

/** Repaint the highlight class and keep the highlighted row in view. */
function paintHighlight(): void {
  for (const row of rows) {
    const selected = row.index === highlight
    row.el.classList.toggle('active', selected)
    if (selected) row.el.scrollIntoView({ block: 'nearest' })
  }
}

/** Move the highlight by one row, wrapping at both ends. */
function move(delta: number): void {
  const first = rows[0]
  if (first === undefined) return
  const current = rows.findIndex((row) => row.index === highlight)
  const next = current === -1
    ? (delta > 0 ? 0 : rows.length - 1)
    : (current + delta + rows.length) % rows.length
  highlight = rows[next]?.index ?? first.index
  paintHighlight()
}

/**
 * Handle one composer keydown. The overlay consumes only the keys it owns, so a
 * bare Enter on a complete line still submits and Esc leaves the draft intact.
 * @param event - the composer keydown.
 */
function handleKeydown(event: KeyboardEvent): void {
  if (!open) return
  // A composing Enter commits the candidate; it never selects a menu row.
  if (isComposingKey(event)) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (event.key === 'Enter' && highlight !== -1) {
    event.preventDefault()
    choose(highlight)
  }
}

/**
 * Adopt one catalog entry: write `/<name> ` into the composer, close the
 * overlay, and hand focus back. This never executes or sends anything — the
 * user still submits, and may type an argument in the space this leaves.
 * @param index - index into the current catalog.
 */
function choose(index: number): void {
  const entry = entries[index]
  if (entry === undefined || inputEl === null) return
  inputEl.value = `/${entry.name} `
  closeMenu()
  // Leave the caret after the space, where an argument would naturally follow.
  const end = inputEl.value.length
  inputEl.setSelectionRange(end, end)
  inputEl.focus()
  onPick?.()
}

/** Hide the overlay without touching the draft. */
export function closeMenu(): void {
  if (!open && rows.length === 0) return
  open = false
  highlight = -1
  rows = []
  if (menuEl !== null) {
    menuEl.textContent = ''
    menuEl.classList.remove('open')
  }
}
