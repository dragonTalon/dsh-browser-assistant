/**
 * Session permission tiers: solving one session's tier from the session's OWN
 * durable knob events, classifying the browser tools, and turning the two into
 * the per-call authorization the extension applies.
 *
 * The tier belongs to the dsh session — this module NEVER stores one. Its
 * source of truth is the session log itself: dsh writes `permission/preset`,
 * `sandbox/mode` and `approval/policy` as ordinary events, and the tier is the
 * pure fold of those three. The `permissions` projection is derived from the
 * very same events, but reading it means traversing a registry lookup, a cell
 * materialization and a schema parse — three layers that can fail, and whose
 * failure is indistinguishable from "no tier data" at the call site. Folding
 * the events skips all of that and makes the result a pure function of the log.
 * The extension receives only the decision, so a modified extension cannot
 * widen its own authority.
 *
 * The projection is still read for two things it is uniquely good for: the
 * preset TABLE (which names the deployment considers valid) and a cross-check
 * against the fold. Neither substitutes for the fold as the gating input.
 *
 * @module
 */

import {
  BRIDGE_DEFAULT_PERMISSION_TIER,
  type BridgePermissionTier,
  type ToolActionClass,
  type ToolCallPolicy,
} from '@dsh-browser/protocol'
import { checkAlignment } from './permission-alignment.ts'
import type {
  CapabilityAbsentReason,
  EventShaped,
  PermissionProjection,
  PermissionResolution,
  PresetBundle,
  PresetBundleEntry,
  PresetTableEntry,
  SessionShaped,
  SolveFailureReason,
} from './permission-types.ts'

/*
 * The solving vocabulary lives in `permission-types.ts` so the cross-check
 * module can describe what it compares without importing this one — a
 * dependency that would otherwise run both ways. Re-exported here because this
 * module is the tier's public surface: consumers and the offline checks import
 * the types from the same place they import the behaviour.
 */
export type {
  CapabilityAbsentReason,
  EventShaped,
  PermissionProjection,
  PermissionResolution,
  PresetBundle,
  PresetBundleEntry,
  PresetTableEntry,
  SessionShaped,
  SolveFailureReason,
} from './permission-types.ts'

/*
 * The session's durable permission knobs.
 *
 * dsh writes the tier as ORDINARY SESSION EVENTS, and the `permissions`
 * projection is itself derived from them. Folding these three is therefore not
 * a second opinion about the tier — it is the same computation the projection
 * performs, minus the registry lookup, the cell materialization and the schema
 * parse that stand between a solver and its input.
 */

/** The preset-intent event: the last preset the user selected. Payload `{ preset }`. */
export const PERMISSION_PRESET_EVENT = 'permission/preset'

/** The sandbox-mode event. Payload `{ mode }`, one of the three sandbox modes. */
export const SANDBOX_MODE_EVENT = 'sandbox/mode'

/** The approval-policy event. Payload `{ policy }`, `'ask'` or `'never'`. */
export const APPROVAL_POLICY_EVENT = 'approval/policy'

/** The derived state dsh reports when the knobs match no preset entry. */
export const CUSTOM_PRESET_VALUE = 'custom'

/** Sandbox modes dsh can record. Anything else is a malformed event. */
const SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Approval policies dsh can record. Anything else is a malformed event. */
const APPROVAL_POLICIES: readonly string[] = ['ask', 'never']

/**
 * The knob bundle dsh ships as a built-in preset, keyed by preset name.
 *
 * Needed because the projection publishes only preset NAMES, never the sandbox
 * and approval each one expands to. Without these bundles the solver could read
 * the preset name but could not tell whether it still matches the recorded
 * knobs — the check that makes a preset selection authoritative. A deployment
 * that redefines or adds a preset declares it in {@link FoldInput.presets}
 * instead, which always wins over this table.
 */
const BUILTIN_PRESET_BUNDLES: Readonly<Record<string, PresetBundle>> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}


/**
 * Everything tier work needs, built ONCE per plugin mount and handed to every
 * consumer — the gate, the change watcher and the model narration.
 *
 * Sharing one toolbag is the point: three independent readers of the same
 * question is how three subtly different answers become possible.
 */
/**
 * The slice of dsh's projection registry this module reads.
 *
 * `snapshot` is the client-visible cut — each value produced by its unit's
 * `view()` and validated against that unit's `viewSchema`. It is read for the
 * preset TABLE and for the cross-check only; the tier itself is folded from the
 * session's own events.
 */
export interface ProjectionReader {
  snapshot(session: never, keys?: readonly string[]): { readonly values?: Record<string, unknown> }
  onChanged(listener: (session: unknown, key: string, value: unknown) => void): () => void
}

export interface PermissionServices {
  /**
   * Solve one session's tier. Never throws: every failure is classified, so a
   * caller must handle all three outcomes instead of defaulting a failure into
   * some tier.
   */
  readonly resolve: (session: unknown) => PermissionResolution
  /**
   * The tier to actually gate with, or `undefined` when the call must fail.
   *
   * This is {@link resolve} plus the cross-check: when the fold and the
   * deployment's own projection name different tiers, the STRICTER of the two
   * wins. Every consumer reads the tier through this one function so the tier
   * the gate enforces, the tier the panel is told about, and the tier the model
   * is narrated cannot drift apart.
   */
  readonly gatedTier: (session: unknown) => BridgePermissionTier | undefined
  /**
   * The preset names this deployment advertises, or an empty list when it
   * advertises none. Used to validate switch targets and to recognize names.
   */
  readonly presetNamesOf: (session: unknown) => readonly string[]
  /** Diagnosable log sink; the bridge supplies its plugin logger. */
  readonly log: (message: string) => void
}

/** The one projection key this module reads. */
const PERMISSIONS_KEY = 'permissions'

/**
 * The slice of dsh's permission-preset service this module probes.
 *
 * Only `{sandbox, approval}` per preset name is needed. The service is the one
 * place the deployment's own preset definitions are legible: the `permissions`
 * projection publishes names and labels, never the knobs a preset expands to,
 * so without this the bridge could not recognize a deployment's own presets at
 * all. Reading it once at mount is what keeps a deployment-defined preset as
 * usable as a built-in one.
 */
export interface PresetServiceLike {
  /** The preset names this deployment declares, in table order. */
  readonly names?: readonly unknown[]
  resolve(name: string): { readonly sandbox?: unknown; readonly approval?: unknown }
}

/**
 * Read every advertised preset's knob bundle from the optional host service.
 *
 * Called ONCE per plugin mount — this is a configuration read, not part of the
 * per-call tier path, so it cannot reintroduce the per-call read failure the
 * event fold exists to remove. A name the service cannot resolve is simply left
 * out, and the caller falls back to the projection's own declaration and then
 * to the built-in defaults; nothing here may throw into plugin startup.
 *
 * The name list comes from the service itself rather than from a session: no
 * session exists yet at mount, and the deployment's table is not per-session.
 */
function probePresetBundles(
  ctx: { get(name: string): unknown },
  log: (message: string) => void,
): Readonly<Record<string, PresetBundle>> {
  const service = ctx.get('permissionPresets') as PresetServiceLike | undefined
  if (service === undefined || typeof service.resolve !== 'function') return {}
  const names = Array.isArray(service.names) ? service.names : []
  if (names.length === 0) {
    log('browser bridge: permissionPresets exposed no preset names; deployment presets will fall back to built-in bundles')
    return {}
  }
  const bundles: Record<string, PresetBundle> = {}
  for (const raw of names) {
    if (typeof raw !== 'string' || raw === '') continue
    try {
      const spec = service.resolve(raw)
      if (typeof spec?.sandbox === 'string' && typeof spec?.approval === 'string') {
        bundles[raw] = { sandbox: spec.sandbox, approval: spec.approval }
      } else {
        log(`browser bridge: preset "${raw}" resolved without a usable sandbox/approval pair`)
      }
    } catch (error) {
      // A preset the deployment declares but the service cannot resolve is an
      // inconsistency worth a line, not a reason to fail startup.
      log(`browser bridge: preset "${raw}" not resolvable from permissionPresets: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return bundles
}

/**
 * Merge the three bundle sources into the table the fold consumes.
 *
 * Precedence is deliberate: what the deployment declares for a name outranks
 * the built-in defaults, because a deployment that redefines a preset means its
 * version. A name absent from every source stays bundle-less, which the fold
 * treats as "cannot be recognized as still matching" — the strict direction.
 *
 * The table is SEEDED with every name the bridge can explain, not only the ones
 * a session currently advertises. A session's log is the authority on what it
 * runs under, and deployments do narrow their advertised table over time, so a
 * recorded preset that has since left the options list must still resolve to
 * its real strength rather than collapsing to an unknown.
 *
 * @param entries - the presets the session advertises.
 * @param hostBundles - bundles read from the deployment's own preset service.
 * @returns one entry per known preset name, in advertised order first.
 */
export function enrichPresetTable(
  entries: readonly PresetTableEntry[],
  hostBundles: Readonly<Record<string, PresetBundle>>,
): PresetBundleEntry[] {
  const seeds: PresetTableEntry[] = [...entries]
  for (const value of Object.keys(BUILTIN_PRESET_BUNDLES)) {
    if (!seeds.some(entry => entry.value === value)) seeds.push({ value })
  }
  for (const value of Object.keys(hostBundles)) {
    if (!seeds.some(entry => entry.value === value)) seeds.push({ value })
  }
  const enriched: PresetBundleEntry[] = []
  for (const entry of seeds) {
    const value = entry.value
    if (typeof value !== 'string' || value === '') continue
    const declared = typeof entry.sandbox === 'string' && typeof entry.approval === 'string'
      ? { sandbox: entry.sandbox, approval: entry.approval }
      : undefined
    const bundle = hostBundles[value] ?? declared ?? BUILTIN_PRESET_BUNDLES[value]
    enriched.push(bundle === undefined ? { value } : { value, sandbox: bundle.sandbox, approval: bundle.approval })
  }
  return enriched
}


/**
 * Build the tier toolbag the gate, watcher and narration share.
 *
 * The projection registry is reached through the plugin context rather than an
 * import, so the bridge keeps its narrow dsh interface: a composed dsh without
 * the registry simply yields `undefined` and the tier feature stays out of the
 * way. But the registry is NOT the tier's source of truth — it is read for the
 * preset table and for the cross-check only. Reading a tier FROM it is what
 * this module no longer does.
 *
 * @param ctx - the plugin's Cordis context.
 * @param log - diagnosable sink; failures are reported here, never swallowed.
 * @returns the accessors, or `undefined` when the deployment has no registry.
 */
export function createPermissionServices(
  ctx: { get(name: string): unknown },
  log: (message: string) => void = () => {},
): PermissionServices | undefined {
  const registry = ctx.get('sessionProjections') as ProjectionReader | undefined
  if (registry === undefined || typeof registry.snapshot !== 'function') return undefined
  const hostBundles = probePresetBundles(ctx, log)

  /**
   * Read the projection's wire view.
   *
   * A throw and an absent value are reported SEPARATELY: collapsing them into
   * one `undefined` is what previously made a broken read indistinguishable
   * from a deployment that has no tiers at all.
   */
  const viewOf = (session: unknown): { readonly view?: PermissionProjection; readonly failure?: string } => {
    let raw: unknown
    try {
      raw = registry.snapshot(session as never, [PERMISSIONS_KEY])?.values?.[PERMISSIONS_KEY]
    } catch (error) {
      // "the read threw" and "the data is not there" are different operational
      // facts — one is a defect to report, the other is a deployment shape — so
      // they must not share one message.
      return { failure: `projection read threw: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (raw === undefined || raw === null) {
      return { failure: 'projection published no permissions value (absent data, not a failed read)' }
    }
    if (typeof raw !== 'object') {
      return { failure: `projection published a ${typeof raw} instead of a value (malformed data, not a failed read)` }
    }
    return { view: raw as PermissionProjection }
  }

  const presetNamesOf = (session: unknown): readonly string[] => {
    const { view } = viewOf(session)
    return view === undefined ? [] : collectPresetNames(view)
  }

  const resolve = (session: unknown): PermissionResolution => {
    // Every failure names its session: a diagnostic that cannot be attributed
    // to one session is unusable in a deployment running several.
    const who = sessionLabelOf(session)
    const fail = (reason: SolveFailureReason, detail: string, options: readonly string[]): PermissionResolution =>
      failure(reason, `${detail} (session ${who})`, options)
    const { view, failure: viewFailure } = viewOf(session)
    const entries = view === undefined
      ? []
      : (view.options ?? []).filter(entry => typeof entry?.value === 'string' && entry.value !== '')
    const table = collectPresetNames(view ?? {})
    // Read the deployment's declaration FIRST: a preset name carries no meaning
    // on its own, so the fold needs the table to know what each name expands to.
    const folded = foldTier(session, enrichPresetTable(entries, hostBundles))
    if (folded.kind === 'unreadable') {
      return fail('session-unreadable', `session log unreadable: ${folded.reason}`, table)
    }
    if (folded.kind === 'malformed') {
      return fail('malformed-knob-event', folded.reason, table)
    }
    // No advertised table means the deployment publishes no tiers. That is the
    // one case where "no capability" is a POSITIVE finding rather than a
    // failure — and, on its own, it is enough: a session log cannot outvote the
    // deployment's own statement that it has no preset table.
    if (table.length === 0) {
      if (viewFailure !== undefined) log(`browser bridge: preset table unavailable (${viewFailure})`)
      return { kind: 'unresolved', reason: 'no-preset-table', options: [] }
    }
    if (folded.preset === undefined && folded.sandbox === undefined && folded.approval === undefined) {
      // A session with a table but not one recorded knob has not reached any
      // tier yet; reporting the deployment default would be a guess.
      return fail('no-knob-events', 'session log holds no permission knob events', table)
    }
    // The recorded preset need not appear in the deployment's advertised list:
    // a deployment can narrow its table after a session recorded a preset, and
    // the session's own log is the authority on what it is running under. What
    // matters is whether the preset can be EXPLAINED — without a bundle its
    // strength is unknowable, and guessing either way would be the bug this
    // module exists to remove. A preset whose knobs have merely DIVERGED is not
    // this case: it is knowable, and the fold already reported it as `custom`.
    if (folded.preset !== undefined && folded.presetBundle === undefined) {
      return fail(
        'preset-bundle-unknown',
        `preset "${folded.preset}" has no known sandbox/approval bundle and the deployment published none`,
        table,
      )
    }
    const solvedName = folded.presetName
    return {
      kind: 'solved',
      value: solvedName,
      // `custom` means the knobs match no preset, so the real strength is
      // unknown; it was already folded to the strictest tier by the fold.
      effective: solvedName === CUSTOM_PRESET_VALUE ? 'read-only' : solvedName,
      options: table,
    }
  }

  /**
   * The tier to gate with: the fold, tightened by the cross-check when the
   * deployment's own projection disagrees.
   *
   * The projection read is used ONLY as a second opinion here. When it is
   * unreadable the folded tier stands unchanged — a failed read can never
   * degrade the answer, which is the whole reason the fold exists. When it IS
   * readable and names a different tier, the stricter one wins: two readings of
   * the same authority that disagree must not resolve toward more permission.
   */
  const gatedTier = (session: unknown): BridgePermissionTier | undefined => {
    const resolution = resolve(session)
    const base = gatingTierOf(resolution)
    if (base === undefined || resolution.kind !== 'solved') return base
    const { view } = viewOf(session)
    const verdict = checkAlignment(resolution, view)
    if (verdict.kind !== 'diverged') return base
    const tightened = stricterTier(base, verdict.projected)
    if (tightened !== base) {
      // Loud on purpose: a mirror that silently disagrees with dsh is the one
      // failure mode this design introduces, so it must never be quiet. The
      // session is named because a bare tier pair is unattributable in a
      // deployment running more than one session.
      log(
        `browser bridge: tier cross-check diverged for session ${sessionLabelOf(session)} — folded "${resolution.value}" `
        + `but the projection says "${verdict.projected}"; gating as "${tightened}". This means the bridge's fold and `
        + 'dsh disagree about this session\'s tier; please report it.',
      )
    }
    return tightened
  }

  return { resolve, gatedTier, presetNamesOf, log }
}

/**
 * Resolve one preset's bundle from an already-enriched table.
 *
 * Precedence was settled by {@link enrichPresetTable}; a name absent from every
 * source resolves to `undefined`, which the fold reads as "cannot be recognized
 * as still matching" rather than as a match.
 */
function bundleFor(preset: string, table: readonly PresetBundleEntry[]): PresetBundle | undefined {
  const entry = table.find(candidate => candidate.value === preset)
  if (entry === undefined || entry.sandbox === undefined || entry.approval === undefined) return undefined
  return { sandbox: entry.sandbox, approval: entry.approval }
}

/** Build a classified failure with the options already solved. */
function failure(
  reason: SolveFailureReason,
  detail: string,
  options: readonly string[],
): PermissionResolution {
  return { kind: 'failed', reason, detail, options }
}

/**
 * Read a session's id off whatever the event feed handed us.
 *
 * Shared by the solver (diagnostic labels) and the watcher (announce/withdraw
 * targeting), so the two cannot disagree about which session an event belongs
 * to.
 * @param session - the session being inspected.
 * @returns its non-empty id, or undefined when the object carries none.
 */
export function sessionIdOf(session: unknown): string | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * A short, log-safe identifier for one session.
 *
 * Falls back to a placeholder rather than to nothing: a failure whose subject
 * cannot be named is still worth seeing, and silently dropping the field would
 * make the diagnostic look complete when it is not.
 * @param session - the session being solved.
 * @returns an id fragment, or a placeholder when the session carries none.
 */
function sessionLabelOf(session: unknown): string {
  const id = sessionIdOf(session)
  if (id === undefined) return '(unidentified)'
  return id.length > 20 ? `${id.slice(0, 20)}…` : id
}

/** Read the advertised preset names, dropping unusable entries. */
function collectPresetNames(view: PermissionProjection): string[] {
  const names: string[] = []
  for (const option of view.options ?? []) {
    const value = option?.value
    if (typeof value === 'string' && value !== '' && !names.includes(value)) names.push(value)
  }
  return names
}

/**
 * How the browser tools divide into action classes. The split is what the
 * tier gate operates on: `read` and `observe` are always allowed, while
 * `mutate` and `navigate` are what a tier actually governs.
 *
 * The classification itself lives in the shared browser-tool registry
 * (`@dsh-browser/protocol`): this module re-exports it so consumers keep one
 * import surface, and no local classification table may re-emerge here.
 */
export type ActionClass = ToolActionClass

export { actionClassOf } from '@dsh-browser/protocol'

/**
 * Whether one action class may reach the page at all under a tier, and whether
 * its execution still needs a human decision. `observe` never needs one: it
 * changes neither page nor tab state, and requiring a prompt for scrolling
 * would make the read-only tier useless on any long page.
 * @param tier - the tier used for gating.
 * @param actionClass - the call's action class.
 * @returns the per-call policy to hand the extension.
 */
export function policyFor(tier: BridgePermissionTier, actionClass: ActionClass): ToolCallPolicy {
  if (actionClass === 'read' || actionClass === 'observe') return 'auto'
  // `custom` means the knobs match no preset, so the real strength is unknown;
  // it was already folded to the strictest tier by the resolver.
  return tier === 'danger-full-access' ? 'auto' : 'ask'
}

/** The gate's verdict for one call: run it under a policy, or refuse it. */
export type CallDecision =
  | { readonly kind: 'allow'; readonly policy: ToolCallPolicy }
  | { readonly kind: 'deny'; readonly actionClass: 'mutate' | 'navigate' }

/**
 * Decide one call from the session's gating tier and the call's action class.
 * This is the single place the two inputs meet, so the deny/allow boundary
 * cannot drift between call sites.
 * @param tier - the tier used for gating.
 * @param actionClass - the call's action class.
 * @returns whether to run the call and under which policy.
 */
export function decideCall(tier: BridgePermissionTier, actionClass: ActionClass): CallDecision {
  // The strictest tier is the only one that refuses a whole action class; the
  // policy value alone cannot express it, because a refused class still reads
  // as `ask` for the tiers below full access.
  if (tier === 'read-only' && (actionClass === 'mutate' || actionClass === 'navigate')) {
    return { kind: 'deny', actionClass }
  }
  return { kind: 'allow', policy: policyFor(tier, actionClass) }
}

/**
 * The gating tier for a resolution.
 *
 * Only a CONFIRMED ABSENT capability gets the deployment default — that value
 * exists to preserve pre-tier behavior on a dsh that has no tiers at all. A
 * failed solve deliberately yields NO tier: callers must fail the call instead
 * of gating it, because substituting a default there would invent an authority
 * the user never selected.
 * @param resolution - a solved resolution.
 * @returns the tier to gate with, or `undefined` when no tier may be used.
 */
export function gatingTierOf(resolution: PermissionResolution): BridgePermissionTier | undefined {
  if (resolution.kind === 'solved') return resolution.effective
  if (resolution.kind === 'unresolved') return BRIDGE_DEFAULT_PERMISSION_TIER
  return undefined
}

/** Strictness order, so a cross-check divergence resolves toward less permission. */
const TIER_STRICTNESS: Record<string, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/**
 * Strictness rank of one tier name.
 *
 * An unrecognized name ranks lowest, matching how the fold treats a name it
 * cannot explain: an unknown strength is read as the least permissive. This is
 * the one ranking the gate, the cross-check AND the downgrade watcher share —
 * keeping it in one function means a stricter/downgrade judgment cannot drift
 * between readers.
 * @param name - tier name as reported.
 * @returns its strictness rank.
 */
export function tierRankOf(name: string): number {
  return TIER_STRICTNESS[name] ?? 0
}

/**
 * The stricter of two tier names.
 *
 * An unrecognized name ranks lowest, matching how the fold treats a name it
 * cannot explain: an unknown strength is read as the least permissive.
 * @param a - one tier name.
 * @param b - the other tier name.
 * @returns whichever is stricter.
 */
export function stricterTier(a: BridgePermissionTier, b: string): BridgePermissionTier {
  return tierRankOf(b) < tierRankOf(a) ? b as BridgePermissionTier : a
}

/** The session records no tier capability and no knob event. */
export const PERMISSION_UNAVAILABLE: PermissionResolution = {
  kind: 'unresolved',
  reason: 'no-preset-table',
  options: [],
}

/** The folded knob state: what the session log says about permissions. */
interface TierFold {
  /** Last recorded preset intent, when the session records one. */
  readonly preset?: string
  /** Last recorded sandbox mode. */
  readonly sandbox?: string
  /** Last recorded approval policy. */
  readonly approval?: string
  /** The derived tier: the recorded preset, or `custom` when it no longer matches. */
  readonly presetName: BridgePermissionTier
  /**
   * The bundle the recorded preset is DEFINED by, when any source explains it.
   *
   * Present even when the recorded knobs have diverged from it: "this preset
   * means these knobs" and "the session still runs under this preset" are
   * different facts, and the caller needs both — the first to decide whether the
   * preset is knowable at all, the second to decide between the preset and
   * `custom`.
   */
  readonly presetBundle?: PresetBundle
}

/** A fold that could not produce knob state, with the reason why. */
type FoldOutcome =
  | ({ readonly kind: 'ok' } & TierFold)
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string }

/**
 * Fold the session's permission knobs out of its own event log.
 *
 * Mirrors dsh's derivation, including its precedence rule: a still-matching
 * last selection wins over table order, which is what makes a preset
 * selection authoritative rather than incidental.
 *
 * @param session - the session whose log is folded.
 * @param table - the deployment's preset declarations, when known. A preset
 *   name alone carries no meaning, so a deployment that redefines what
 *   `workspace-write` expands to must be able to say so here; without it the
 *   built-in bundles are the only interpretation available.
 * @returns the knob state, or a classified reason it could not be produced.
 */
export function foldTier(session: unknown, table: readonly PresetBundleEntry[] = []): FoldOutcome {
  if (session === null || typeof session !== 'object') {
    return { kind: 'unreadable', reason: 'no session on the calling context' }
  }
  const shaped = session as Partial<SessionShaped>
  let events: readonly EventShaped[] | undefined
  try {
    events = readEvents(shaped)
  } catch (error) {
    // A throwing reader is a defect to classify, never an exception to let
    // through: `resolve` promises every failure is classified, and the
    // original message stays in the reason so the defect stays diagnosable.
    return { kind: 'unreadable', reason: `session event log read threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (events === undefined) return { kind: 'unreadable', reason: 'session exposes no readable event log' }

  let preset: string | undefined
  let sandbox: string | undefined
  let approval: string | undefined
  for (const event of events) {
    const type = event?.type
    if (type === PERMISSION_PRESET_EVENT) {
      const value = stringField(event?.data, 'preset')
      if (value === undefined) return { kind: 'malformed', reason: `${PERMISSION_PRESET_EVENT} carried no preset name` }
      preset = value
    } else if (type === SANDBOX_MODE_EVENT) {
      const value = stringField(event?.data, 'mode')
      if (value === undefined || !SANDBOX_MODES.includes(value)) {
        return { kind: 'malformed', reason: `${SANDBOX_MODE_EVENT} carried mode ${JSON.stringify(value)}` }
      }
      sandbox = value
    } else if (type === APPROVAL_POLICY_EVENT) {
      const value = stringField(event?.data, 'policy')
      if (value === undefined || !APPROVAL_POLICIES.includes(value)) {
        return { kind: 'malformed', reason: `${APPROVAL_POLICY_EVENT} carried policy ${JSON.stringify(value)}` }
      }
      approval = value
    }
  }
  // The recorded preset is authoritative only while its own bundle still
  // matches the recorded knobs; a later knob change means the selection no
  // longer describes the state, which is exactly what `custom` reports.
  const recordedBundle = preset === undefined ? undefined : bundleFor(preset, table)
  const stillMatches = preset !== undefined
    && recordedBundle !== undefined
    && (sandbox === undefined || recordedBundle.sandbox === sandbox)
    && (approval === undefined || recordedBundle.approval === approval)
  const presetName: BridgePermissionTier = stillMatches ? preset as BridgePermissionTier : CUSTOM_PRESET_VALUE
  return {
    kind: 'ok',
    presetName,
    ...(preset === undefined ? {} : { preset }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(approval === undefined ? {} : { approval }),
    ...(recordedBundle === undefined ? {} : { presetBundle: recordedBundle }),
  }
}

/**
 * Read the session's events, preferring the batched reader.
 *
 * `snapshotEvents` is the same in-memory log view `eventAt` addresses, so the
 * two agree by construction; the loop over `seq` is only a fallback for a
 * session shape that does not expose the array form. A throwing reader is left
 * to propagate: {@link foldTier} is the boundary that classifies it.
 */
function readEvents(session: Partial<SessionShaped>): readonly EventShaped[] | undefined {
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events as readonly EventShaped[]
  }
  if (typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return undefined
  const events: EventShaped[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event !== undefined) events.push(event as EventShaped)
  }
  return events
}

/** Read one string field off an event payload. */
function stringField(data: unknown, key: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
