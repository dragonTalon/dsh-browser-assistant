/**
 * Pure view-model builder for the panel's session picker.
 *
 * Stateless and DOM-free so the selection rules — which sessions are offered,
 * how each row is labelled, how many rows are rendered — can be asserted
 * offline by `scripts/check-session-selection.mjs` against the real source.
 *
 * Input is a raw `session.list` response, which the bridge forwards verbatim;
 * every field is therefore re-validated here instead of trusted.
 *
 * @module
 */

import { isRecord } from './tools/guards.ts'

/** Maximum number of reusable sessions offered in the picker. */
export const SESSION_OPTION_LIMIT = 50

/** One picker row derived from a dsh `session.list` entry. */
export interface SessionOption {
  /** Session identity, used verbatim as the `<option>` value. */
  readonly id: string
  /** Workspace-ish prefix: the working directory's last segment, `''` when unknown. */
  readonly workspace: string
  /** Title, or a shortened session identity when the list carries no title. */
  readonly label: string
  /** Relative activity time, `''` when unknown. */
  readonly sublabel: string
  /** Whether the session currently runs a turn. */
  readonly running: boolean
}

/** Result of mapping a `session.list` response onto picker rows. */
export interface SessionOptions {
  /** Rows to render, most recently active first. */
  readonly options: readonly SessionOption[]
  /** Candidates that survived filtering, before the cap was applied. */
  readonly total: number
  /** Whether the cap left candidates out. */
  readonly truncated: boolean
}

/** A validated candidate held during sorting. */
interface Candidate {
  readonly id: string
  readonly updatedAt: number
  readonly running: boolean
  readonly workspace: string
  readonly label: string
  readonly sublabel: string
}

/**
 * Build the picker's rows from a `session.list` response.
 *
 * Empty sessions (`blank`) and sub-agent sessions are excluded: neither is a
 * conversation the user can meaningfully continue. Rows are ordered by most
 * recent activity and capped at {@link SESSION_OPTION_LIMIT}.
 *
 * @param items - raw `items` array from `session.list`.
 * @param now - wall-clock milliseconds used for the relative-time labels.
 * @param limit - maximum rows to render; defaults to the picker cap.
 * @returns rows to render plus truncation facts for the caller's notice.
 */
export function buildSessionOptions(
  items: unknown,
  now: number,
  limit: number = SESSION_OPTION_LIMIT,
): SessionOptions {
  const candidates: Candidate[] = []
  if (Array.isArray(items)) {
    for (const entry of items) {
      const candidate = candidateOf(entry, now)
      if (candidate !== undefined) candidates.push(candidate)
    }
  }
  // Most recently active first; `sort` is stable, so equal timestamps keep the
  // Host's own order.
  candidates.sort((left, right) => right.updatedAt - left.updatedAt)
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : SESSION_OPTION_LIMIT
  const shown = candidates.slice(0, cap)
  return {
    options: shown.map(({ id, workspace, label, sublabel, running }) => ({
      id,
      workspace,
      label,
      sublabel,
      running,
    })),
    total: candidates.length,
    truncated: shown.length < candidates.length,
  }
}

/**
 * The exact text of one `<option>`: workspace prefix first, then the running
 * marker, the title, and the relative activity time.
 *
 * The workspace leads because a session list is scanned by "which project was
 * this in?" before "which conversation was it?"; the session id itself never
 * appears unless the list carries no title at all.
 *
 * @param option - one row from {@link buildSessionOptions}.
 * @returns the option's display text.
 */
export function formatSessionOption(option: SessionOption): string {
  const prefix = option.workspace === '' ? '' : `[${option.workspace}] `
  const marker = option.running ? '● ' : ''
  const meta = option.sublabel === '' ? '' : ` · ${option.sublabel}`
  return `${prefix}${marker}${option.label}${meta}`
}

/** Validate one raw entry; `undefined` means "not a reusable session". */
function candidateOf(entry: unknown, now: number): Candidate | undefined {
  if (!isRecord(entry)) return undefined
  const id = entry.sessionId
  if (typeof id !== 'string' || id === '') return undefined
  if (entry.blank === true) return undefined
  if (entry.origin === 'subagent') return undefined
  const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0
  return {
    id,
    updatedAt,
    running: entry.running === true,
    workspace: cwdSegment(entry.cwd) ?? '',
    label: labelOf(id, entry.projections),
    sublabel: updatedAt > 0 ? relativeTime(updatedAt, now) : '',
  }
}

/**
 * Primary label: the session title when the list carries one, otherwise a
 * shortened identity so a row is never blank.
 */
function labelOf(id: string, projections: unknown): string {
  return titleOf(projections) ?? `${id.slice(0, 8)}…`
}

/** Read `projections.values.title`, collapsing whitespace for one-line rows. */
function titleOf(projections: unknown): string | undefined {
  if (!isRecord(projections)) return undefined
  const values = projections.values
  if (!isRecord(values)) return undefined
  const title = values.title
  if (typeof title !== 'string') return undefined
  const collapsed = title.replace(/\s+/gu, ' ').trim()
  return collapsed === '' ? undefined : collapsed
}

/** Human relative time; a future timestamp reads as "just now". */
function relativeTime(updatedAt: number, now: number): string {
  const seconds = Math.floor((now - updatedAt) / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const date = new Date(updatedAt)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Last path segment of a working directory, tolerating POSIX and Windows separators. */
function cwdSegment(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined
  const trimmed = cwd.replace(/[/\\]+$/u, '')
  if (trimmed === '') return undefined
  const segments = trimmed.split(/[/\\]+/u)
  const last = segments[segments.length - 1]
  return last === undefined || last === '' ? undefined : last
}
