/**
 * The slash vocabulary's pure rules: reading a host catalog, merging dsh's two
 * slash namespaces, filtering a draft, and recognizing what counts as a slash
 * line.
 *
 * These live in `common/` — with no DOM and no transport — because they are the
 * part of the slash feature that can be decided without a browser. The overlay
 * module drives them; the repo's own offline checks (`scripts/check-*.mjs`)
 * bundle this file directly, which is only possible while it stays free of
 * import-time side effects.
 *
 * dsh publishes slash entries from two parallel namespaces:
 *
 * - **Commands** (`commands.list`) run a host handler and open no turn.
 * - **Skills** (`skills.list`) have no execute endpoint; they are invoked by
 *   sending `/<name>` as an ordinary prompt, which the host's pre-step boundary
 *   recognizes as a load gesture.
 *
 * @module
 */

import type { CommandDescriptorWire, SkillSummaryWire } from '@dsh-browser/protocol'

/** Which namespace published a slash entry; it also decides how it is invoked. */
export type SlashKind = 'command' | 'skill'

/**
 * One slash entry the host published for the bound session.
 *
 * The wire contracts from `@dsh-browser/protocol` state what a well-formed host
 * payload contains. This parser is deliberately MORE permissive than those
 * types: a descriptor whose `description` cannot be read is still kept, because
 * a missing column must cost the user the column, not the entry. The shared
 * types are the contract; this permissiveness only ever over-accepts a payload,
 * it never lets a name resolve differently.
 */
export interface SlashEntry extends
  Omit<CommandDescriptorWire, 'description' | 'input'>,
  Partial<Omit<SkillSummaryWire, 'name' | 'modelInvocable'>> {
  /** Host-published description shown verbatim; absent when unreadable. */
  readonly description?: string
  /**
   * Host-published argument hint (commands only); absent when the host
   * published none. A skill's name alone is the whole gesture.
   */
  readonly hint?: string
  /** Whether a skill is also model-invocable; absent for commands. */
  readonly modelInvocable?: boolean
  /** Publishing namespace, which is also the invocation route. */
  readonly kind: SlashKind
}

/** Read a non-empty string field from an untrusted object. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Normalize one host catalog entry. A malformed row is skipped rather than
 * failing the whole catalog: one bad entry must not cost the user everything.
 *
 * Only the NAME decides whether an entry exists. An entry whose description or
 * argument hint cannot be read keeps its name, because the name is what the
 * submit path resolves against: dropping the entry here would make a real
 * command indistinguishable from an unknown word, and a typed `/<name>` would
 * be spent as an ordinary prompt to the model.
 *
 * @param value - one raw catalog element.
 * @param kind - namespace the element came from.
 * @returns the entry, or undefined when it cannot be read.
 */
export function readEntry(value: unknown, kind: SlashKind): SlashEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const name = stringField(raw, 'name')
  if (name === undefined) return undefined
  const description = stringField(raw, 'description')
  if (kind === 'skill') {
    // A skill's model-invocability is the only extra flag the catalog carries,
    // and it is what tells the user this name is theirs to type.
    const modelInvocable = raw.modelInvocable
    return {
      name,
      kind,
      ...(description === undefined ? {} : { description }),
      ...(typeof modelInvocable === 'boolean' ? { modelInvocable } : {}),
    }
  }
  const input = raw.input
  const hint = typeof input === 'object' && input !== null
    ? stringField(input as Record<string, unknown>, 'hint')
    : undefined
  return {
    name,
    kind,
    ...(description === undefined ? {} : { description }),
    ...(hint === undefined ? {} : { hint }),
  }
}

/**
 * Read one catalog response into entries, skipping rows that cannot be read.
 * @param value - the raw RPC result.
 * @param kind - namespace the response belongs to.
 * @param unwrap - key holding the array, when the response is an envelope.
 * @returns the entries that could be read.
 */
export function readCatalog(value: unknown, kind: SlashKind, unwrap?: string): readonly SlashEntry[] {
  // `null` needs its own guard: optional chaining only short-circuits undefined.
  const source = unwrap === undefined
    ? value
    : (value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[unwrap] : undefined)
  if (!Array.isArray(source)) return []
  const read: SlashEntry[] = []
  for (const item of source) {
    const entry = readEntry(item, kind)
    if (entry !== undefined) read.push(entry)
  }
  return read
}

/**
 * Merge the two namespaces into one menu order, giving commands precedence on a
 * shared name exactly as the host's own adjudication does: a line that both
 * publish resolves to the command, so the command row is the truthful one.
 * @param commands - entries published by the command registry.
 * @param skills - entries published by the skill registry.
 * @returns the merged list, sorted by name.
 */
export function merge(commands: readonly SlashEntry[], skills: readonly SlashEntry[]): readonly SlashEntry[] {
  const taken = new Set(commands.map((entry) => entry.name))
  const merged = [...commands, ...skills.filter((entry) => !taken.has(entry.name))]
  // A stable name order keeps the unfiltered menu predictable; a fuzzy score
  // would be a second, invisible ordering rule for no gain here.
  return merged.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/**
 * The `/`-prefix filter text, or undefined when the draft is not a name draft.
 * @param value - the current composer text.
 * @returns the filter text, or undefined once the draft is past the name.
 */
export function queryOf(value: string): string | undefined {
  if (!value.startsWith('/')) return undefined
  const rest = value.slice(1)
  // Once a separator appears the user is past the name: the menu's job is done,
  // and a later submission still matches by its exact first token.
  if (/\s/.test(rest)) return undefined
  return rest
}

/**
 * Entries matching the current filter text.
 * @param query - the `/`-prefix filter text.
 * @param source - the catalog to filter.
 * @returns the matching entries, in catalog order.
 */
export function matches(query: string, source: readonly SlashEntry[]): readonly SlashEntry[] {
  if (query === '') return source
  const needle = query.toLowerCase()
  return source.filter((entry) => entry.name.toLowerCase().includes(needle))
}

/**
 * Read the name off a submitted slash draft — the single definition of what
 * "this line is a slash entry" means, shared by the menu and the submit path so
 * the two cannot disagree about which lines leave the ordinary send path.
 *
 * The pattern is dsh's own `parseCommand` verbatim, including its decision that
 * a name starts with a lowercase letter. That shared grammar is the point: a
 * pattern that accepted more than the host's parser would let the menu offer a
 * line the host refuses to parse, so the line would reach the model as prose.
 *
 * @param text - the trimmed composer draft.
 * @returns the name without its slash, or undefined when the line is not a
 *   slash line (mirrors dsh's own `parseCommand` shape).
 */
export function submittedSlashName(text: string): string | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(text)
  return match?.[1]
}

/**
 * Whether a key event belongs to an in-progress IME composition.
 *
 * `isComposing` covers most browsers, but the Enter that COMMITS a candidate
 * can arrive after `compositionend`, where `isComposing` is already false and
 * only the legacy `keyCode === 229` marker remains. In a zh/ja UI that Enter is
 * routine, and consuming it would rewrite the composer instead of accepting the
 * candidate the user just chose.
 * @param event - the composer keydown.
 * @returns true when the menu must leave this key alone.
 */
export function isComposingKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}
