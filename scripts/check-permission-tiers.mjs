#!/usr/bin/env node
/**
 * Behavioral check for the permission-tier rules.
 *
 * The repo has no test suite, so this bundles the REAL sources with the same
 * esbuild resolution order as the package build scripts and asserts every
 * scenario in `openspec/changes/panel-permission-tiers/specs/` that is
 * decidable without a browser or a running dsh.
 *
 * Three modules are covered, deliberately:
 * - `bridge-dsh/src/permission.ts` — tier resolution, the four action classes,
 *   and the gate verdict (the security-relevant core).
 * - `bridge-dsh/src/permission-watch.ts` — the change/downgrade reactions, with
 *   a fake projection feed.
 * - `extension/src/background/authorization.ts` — the per-call policy the
 *   extension applies, including the absent-policy fallback.
 *
 * Usage: pnpm check:permission   (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'permission-tiers')

function resolveEsbuild() {
  const candidates = [
    process.env.ESBUILD,
    join(repoRoot, 'packages/extension/node_modules/.bin/esbuild'),
    join(repoRoot, 'packages/bridge-dsh/node_modules/.bin/esbuild'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('error: esbuild not found (run pnpm install, or set ESBUILD)')
    process.exit(1)
  }
  return found
}

/** Bundle one module for Node, aliasing the shared protocol. */
function build(relativePath, name) {
  const outfile = join(outDir, `${name}.mjs`)
  const result = spawnSync(resolveEsbuild(), [
    join(repoRoot, relativePath),
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    `--outfile=${outfile}`,
    `--alias:@dsh-browser/protocol=${join(repoRoot, 'packages/protocol/src/index.ts')}`,
    '--log-level=error',
  ], { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return outfile
}

mkdirSync(outDir, { recursive: true })

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

// ---------------------------------------------------------------------------
// Part 1: the bridge's tier solver, classifier and gate (pure).
//
// The tier is folded from the session's OWN knob events. These assertions pin
// that source, the three-state outcome, and the classifier/gate on top of it.
// ---------------------------------------------------------------------------
const permission = await import(pathToFileURL(build('packages/bridge-dsh/src/permission.ts', 'permission')).href)
const {
  foldTier, enrichPresetTable, actionClassOf, policyFor, decideCall, gatingTierOf, createPermissionServices,
} = permission

const TIERS = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'danger-full-access', name: 'danger-full-access' },
]

/** One session whose log is exactly the events handed in. */
const sessionWith = (...events) => ({ id: 'session-x', seq: events.length, snapshotEvents: () => events })

/** The three knob events dsh appends when a preset is applied. */
const presetEvents = (preset, sandbox, approval) => [
  { seq: 0, type: 'permission/preset', data: { preset } },
  { seq: 1, type: 'sandbox/mode', data: { mode: sandbox } },
  { seq: 2, type: 'approval/policy', data: { policy: approval } },
]

const FULL_ACCESS = presetEvents('danger-full-access', 'danger-full-access', 'never')
const WORKSPACE_WRITE = presetEvents('workspace-write', 'workspace-write', 'ask')

/**
 * The enriched preset table the fold consumes.
 *
 * Built through the REAL enrichment, so the assertions exercise the same
 * precedence the resolver uses (deployment declaration, then built-in bundle)
 * instead of a hand-written copy that could drift from it.
 */
const ENRICHED = (extra = [], host = {}) => enrichPresetTable(
  [...TIERS.map(t => ({ value: t.value })), ...extra],
  host,
)

/**
 * Build the toolbag against fake surroundings.
 * @param view the `permissions` projection value, or undefined for none
 * @param presets host `permissionPresets` service, or undefined for none
 */
function servicesOf(view, presets, log = () => {}) {
  const registry = {
    stateOf: () => { throw new Error('stateOf must never be read as a tier view') },
    snapshot: () => ({ values: view === undefined ? {} : { permissions: view } }),
  }
  return createPermissionServices(
    { get: (name) => (name === 'sessionProjections' ? registry : (name === 'permissionPresets' ? presets : undefined)) },
    log,
  )
}

const PLAIN_DEPLOYMENT = servicesOf({ options: TIERS, currentValue: 'workspace-write' })

// --- the fold: the session's own log is the source of truth ---
{
  const folded = foldTier(sessionWith(...FULL_ACCESS), ENRICHED())
  check(
    '从会话旋钮事件求解档位',
    folded.kind === 'ok' && folded.presetName === 'danger-full-access' && folded.sandbox === 'danger-full-access',
    `got ${JSON.stringify(folded)}`,
  )
  const solved = PLAIN_DEPLOYMENT.resolve(sessionWith(...FULL_ACCESS))
  check(
    '已求解档位走 gate 的 gating 值',
    solved.kind === 'solved' && solved.value === 'danger-full-access' && gatingTierOf(solved) === 'danger-full-access',
    `got ${JSON.stringify(solved)}`,
  )
  const again = PLAIN_DEPLOYMENT.resolve(sessionWith(...FULL_ACCESS))
  check(
    '同一会话内求解结果稳定（同一日志必得同一结果）',
    JSON.stringify(again) === JSON.stringify(solved),
    'the same log must not yield two different tiers',
  )
}

// --- the solver never throws: a throwing event-log reader is classified ---
{
  const throwing = { id: 'session-x', seq: 0, snapshotEvents: () => { throw new Error('log exploded') } }
  const folded = foldTier(throwing, ENRICHED())
  check(
    '事件日志读取抛错被分类为 unreadable 而不是穿透',
    folded.kind === 'unreadable' && /read threw/.test(folded.reason) && /log exploded/.test(folded.reason),
    `got ${JSON.stringify(folded)}`,
  )
  const solved = PLAIN_DEPLOYMENT.resolve(throwing)
  check(
    'resolve 在日志读取抛错时返回分类失败且不抛出',
    solved.kind === 'failed' && solved.reason === 'session-unreadable' && /log exploded/.test(solved.detail),
    `got ${JSON.stringify(solved)}`,
  )
}

// --- the three states must not be folded into each other ---
{
  const noTable = servicesOf(undefined)
  const unresolved = noTable.resolve(sessionWith())
  check(
    '部署无权限能力 → 无档位（不猜档位）',
    unresolved.kind === 'unresolved' && unresolved.reason === 'no-preset-table',
    `got ${JSON.stringify(unresolved)}`,
  )
  check(
    '无档位能力时 gating 用部署默认档位',
    gatingTierOf(unresolved) === 'workspace-write',
    'no capability means the pre-tier behavior, which was workspace-write',
  )
  const noKnobs = PLAIN_DEPLOYMENT.resolve(sessionWith())
  check(
    '有预设表但会话无旋钮事件 → 求解失败（不按默认档位）',
    noKnobs.kind === 'failed' && noKnobs.reason === 'no-knob-events' && gatingTierOf(noKnobs) === undefined,
    `got ${JSON.stringify(noKnobs)}`,
  )
  check(
    '求解失败的 detail 含会话标识',
    noKnobs.kind === 'failed' && /session session-x/.test(noKnobs.detail),
    `detail=${noKnobs.kind === 'failed' ? noKnobs.detail : '(not a failure)'}`,
  )
  check(
    '求解失败不折算为任何档位（gating 无值）',
    gatingTierOf({ kind: 'failed', reason: 'session-unreadable', detail: 'x', options: [] }) === undefined,
    'a failed solve must yield no tier at all, so the gate must fail the call',
  )
  const unreadable = PLAIN_DEPLOYMENT.resolve({ id: 'session-y' })
  check(
    '会话没有可读事件日志 → session-unreadable',
    unreadable.kind === 'failed' && unreadable.reason === 'session-unreadable',
    `got ${JSON.stringify(unreadable)}`,
  )
  const malformed = PLAIN_DEPLOYMENT.resolve(sessionWith({ seq: 0, type: 'sandbox/mode', data: { mode: 'wide-open' } }))
  check(
    '畸形旋钮事件 → malformed（不静默忽略）',
    malformed.kind === 'failed' && malformed.reason === 'malformed-knob-event',
    `got ${JSON.stringify(malformed)}`,
  )
  // A name nobody can explain has unknowable strength. Failing is the only
  // honest answer: guessing it is a preset would authorize work, and guessing
  // it is read-only would refuse work the user did authorize.
  const unexplainable = PLAIN_DEPLOYMENT.resolve(sessionWith(...presetEvents('super-user', 'workspace-write', 'ask')))
  check(
    '无法解释的档位名 → preset-bundle-unknown（不猜）',
    unexplainable.kind === 'failed' && unexplainable.reason === 'preset-bundle-unknown'
      && gatingTierOf(unexplainable) === undefined,
    `got ${JSON.stringify(unexplainable)}`,
  )
}

// --- custom and unknown names fold to the strictest tier ---
{
  // The preset's own bundle must MATCH the recorded knobs for the selection to
  // still describe the state; a divergent knob means the user moved a knob
  // independently, which is exactly what dsh reports as `custom`.
  const custom = PLAIN_DEPLOYMENT.resolve(sessionWith(...presetEvents('danger-full-access', 'read-only', 'ask')))
  check(
    'custom 如实上报但按最严档位判定',
    custom.kind === 'solved' && custom.value === 'custom' && custom.effective === 'read-only'
      && decideCall(gatingTierOf(custom), 'mutate').kind === 'deny',
    `got ${JSON.stringify(custom)}`,
  )
  // A recorded preset the deployment no longer advertises still resolves, as
  // long as the bridge can explain it: the session's log says what it runs
  // under, and a narrowed table must not silently change that reading.
  const narrowed = PLAIN_DEPLOYMENT.resolve(sessionWith(...presetEvents('workspace-write', 'workspace-write', 'ask')))
  check(
    '会话记录的档位名不在当前公布表中仍能求解（会话日志是权威）',
    narrowed.kind === 'solved' && narrowed.value === 'workspace-write',
    `got ${JSON.stringify(narrowed)}`,
  )
}

// --- a deployment's OWN presets are usable, not denied ---
{
  const hostPresets = {
    names: ['read-only', 'workspace-write', 'danger-full-access', 'team-write'],
    resolve: (name) => ({
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      'team-write': { sandbox: 'workspace-write', approval: 'ask' },
    })[name],
  }
  const view = {
    options: [...TIERS, { value: 'team-write', name: 'Team write' }],
    currentValue: 'team-write',
  }
  const solved = servicesOf(view, hostPresets).resolve(sessionWith(...presetEvents('team-write', 'workspace-write', 'ask')))
  check(
    '自定义预设名按部署公布的含义求解（不折成 read-only）',
    solved.kind === 'solved' && solved.value === 'team-write' && solved.effective === 'team-write'
      && decideCall(gatingTierOf(solved), 'mutate').kind === 'allow',
    `got ${JSON.stringify(solved)}`,
  )
  // Without the host service the bundle is unknowable, and the honest answer is
  // a diagnosable failure — never a guess in either direction.
  const noService = servicesOf(view, undefined).resolve(sessionWith(...presetEvents('team-write', 'workspace-write', 'ask')))
  check(
    'bundle 不可得时自定义预设名显式失败而非被猜',
    noService.kind === 'failed' && noService.reason === 'preset-bundle-unknown' && gatingTierOf(noService) === undefined,
    `got ${JSON.stringify(noService)}`,
  )
  // A host service whose declared spec contradicts the recorded knobs must NOT
  // be adopted as a match: the knobs are what the session actually runs under.
  const contradictory = servicesOf(
    { options: [...TIERS, { value: 'team-write', name: 'Team write' }], currentValue: 'team-write' },
    hostPresets,
  ).resolve(sessionWith(...presetEvents('team-write', 'read-only', 'never')))
  check(
    '记录的旋钮与该预设含义不符时不冒充该预设',
    contradictory.kind === 'solved' && contradictory.value === 'custom' && contradictory.effective === 'read-only',
    `got ${JSON.stringify(contradictory)}`,
  )
}

// --- the accessor itself ---
{
  const logs = []
  const services = servicesOf({ options: TIERS, currentValue: 'read-only' }, undefined, (m) => logs.push(m))
  const solved = services.resolve(sessionWith(...presetEvents('read-only', 'read-only', 'ask')))
  check(
    '只读档位解析为拒绝改页/导航，而读取仍放行',
    solved.kind === 'solved'
      && decideCall(gatingTierOf(solved), 'mutate').kind === 'deny'
      && decideCall(gatingTierOf(solved), 'read').policy === 'auto',
    `got ${JSON.stringify(solved)}`,
  )
  check(
    '注册表缺少 snapshot 能力时报告无档位（而非猜一个）',
    createPermissionServices({ get: () => ({ stateOf: () => ({}) }) }) === undefined,
    'a registry without the client-view accessor carries no tier capability',
  )
  check(
    '预设名集合被去重并剔除空名',
    JSON.stringify(servicesOf({ options: [...TIERS, { value: 'read-only' }, { value: '' }, { value: 7 }] }, undefined)
      .presetNamesOf(sessionWith())) === JSON.stringify(['read-only', 'workspace-write', 'danger-full-access']),
    'the advertised-name list must not carry duplicates or unusable entries',
  )
  const absent = servicesOf({ options: TIERS }, undefined, (m) => logs.push(m)).resolve(sessionWith(...WORKSPACE_WRITE))
  check(
    '投影不可用时仍按折叠结果判定（不因读取失败降级）',
    absent.kind === 'solved' && absent.value === 'workspace-write',
    `got ${JSON.stringify(absent)}`,
  )
}

// --- the model-facing text: a failure must not read as a refusal ---
//
// These sentences are the only part of the gate the MODEL reads, and the wrong
// wording sends it hunting for another tool that performs the same act. They
// live in their own module precisely so they can be asserted here rather than
// only inside a running dsh.
{
  const messages = await import(
    pathToFileURL(build('packages/bridge-dsh/src/tier-messages.ts', 'messages')).href
  )
  const { deniedMessage, unresolvedMessage } = messages

  const failed = {
    kind: 'failed',
    reason: 'preset-bundle-unknown',
    detail: 'preset "super-user" has no known sandbox/approval bundle (session sess-1)',
    options: ['read-only'],
  }
  const unresolvedText = unresolvedMessage('browser_click', failed)
  check(
    '求解失败文案不表述为档位拒绝',
    /not a tier refusal/.test(unresolvedText)
      && !/does not allow/.test(unresolvedText)
      && !/permission tier "/.test(unresolvedText),
    unresolvedText,
  )
  check(
    '求解失败文案说明档位无法确定并给出重试路径',
    /could not be determined/.test(unresolvedText) && /Retry the call/.test(unresolvedText),
    unresolvedText,
  )
  check(
    '求解失败文案带上失败环节的细节（可定位）',
    /preset-bundle-unknown|super-user/.test(unresolvedText),
    unresolvedText,
  )
  // A tier refusal is the opposite case: it must name the tier and stay a refusal.
  const deniedText = deniedMessage('browser_click', 'mutate', {
    kind: 'solved', value: 'read-only', effective: 'read-only', options: ['read-only'],
  })
  check(
    '档位拒绝文案命名档位且不提「无法确定」',
    /read-only/.test(deniedText) && /does not allow/.test(deniedText)
      && !/could not be determined/.test(deniedText) && !/not a tier refusal/.test(deniedText),
    deniedText,
  )
}

// --- the cross-check: the mirror must not silently disagree with dsh ---
{
  const foldFull = sessionWith(...FULL_ACCESS)

  // Agreement is the normal case and must be quiet.
  const agreedLogs = []
  const agreed = servicesOf({ options: TIERS, currentValue: 'danger-full-access' }, undefined, (m) => agreedLogs.push(m))
  const agreedTier = agreed.gatedTier(foldFull)
  check(
    '折叠与投影一致时按折叠档位判定且不留痕',
    agreedTier === 'danger-full-access' && agreedLogs.length === 0,
    `tier=${agreedTier} logs=${JSON.stringify(agreedLogs)}`,
  )

  // Divergence: the projection is a second opinion, and two readings that
  // disagree must not resolve toward MORE permission.
  const divergedLogs = []
  const diverged = servicesOf({ options: TIERS, currentValue: 'read-only' }, undefined, (m) => divergedLogs.push(m))
  const divergedTier = diverged.gatedTier(foldFull)
  check(
    '折叠与投影分歧时取更严一方判定',
    divergedTier === 'read-only',
    `got ${divergedTier}; the stricter reading must win`,
  )
  check(
    '折叠与投影分歧时留下可定位记录',
    divergedLogs.length === 1 && /diverged/.test(divergedLogs[0])
      && /danger-full-access/.test(divergedLogs[0]) && /read-only/.test(divergedLogs[0]),
    `logs=${JSON.stringify(divergedLogs)}`,
  )
  check(
    '分歧记录含会话标识（多会话下可归属）',
    /session session-x/.test(divergedLogs[0] ?? ''),
    `logs=${JSON.stringify(divergedLogs)}`,
  )
  // The reverse direction: a more permissive projection must not widen the fold.
  const wider = servicesOf({ options: TIERS, currentValue: 'danger-full-access' }, undefined, () => {})
  check(
    '投影更宽松时不放宽折叠结果',
    wider.gatedTier(sessionWith(...presetEvents('read-only', 'read-only', 'ask'))) === 'read-only',
    'a permissive projection must never widen a stricter fold',
  )

  // An unreadable projection cannot degrade the answer: the fold stands.
  const unreadable = servicesOf({ options: TIERS }, undefined, (m) => divergedLogs.push(m))
  check(
    '投影不可读时仍按折叠判定（核对不参与降级）',
    unreadable.gatedTier(foldFull) === 'danger-full-access',
    `got ${unreadable.gatedTier(foldFull)}`,
  )
  // And a failed solve stays a failure — the cross-check must not revive it.
  const failedSolve = servicesOf({ options: TIERS, currentValue: 'danger-full-access' }, undefined, () => {})
  check(
    '求解失败时 gatedTier 仍为空（核对不会复活失败）',
    failedSolve.gatedTier(sessionWith({ seq: 0, type: 'sandbox/mode', data: { mode: 'wide-open' } })) === undefined,
    'a failed solve must stay a failure',
  )
}

// --- action classes: all 12 tools, exactly as the spec defines them ---
const EXPECTED_CLASSES = {
  browser_snapshot: 'read',
  browser_get_text: 'read',
  browser_scroll: 'observe',
  browser_wait: 'observe',
  browser_click: 'mutate',
  browser_type: 'mutate',
  browser_press: 'mutate',
  browser_navigate: 'navigate',
  browser_open_tab: 'navigate',
  browser_back: 'navigate',
  browser_forward: 'navigate',
  browser_reload: 'navigate',
}
for (const [tool, expected] of Object.entries(EXPECTED_CLASSES)) {
  check(
    `动作分类 ${tool} → ${expected}`,
    actionClassOf(tool) === expected,
    `got ${actionClassOf(tool)}`,
  )
}
check(
  '非浏览器工具没有动作分类',
  actionClassOf('browser_launch_missiles') === undefined && actionClassOf('run_code') === undefined,
  'an unknown name must not be silently classified',
)

// --- the full matrix: 12 tools x 3 tiers ---
// Expected per-call outcome derived from the spec table, stated independently
// of the implementation so a flipped branch cannot silently pass.
function expectedOutcome(tier, actionClass) {
  if (actionClass === 'read' || actionClass === 'observe') return 'allow:auto'
  if (tier === 'read-only') return 'deny'
  return tier === 'danger-full-access' ? 'allow:auto' : 'allow:ask'
}
let matrixFailures = 0
for (const tier of ['read-only', 'workspace-write', 'danger-full-access']) {
  for (const [tool, actionClass] of Object.entries(EXPECTED_CLASSES)) {
    const decision = decideCall(tier, actionClass)
    const actual = decision.kind === 'deny' ? 'deny' : `allow:${decision.policy}`
    if (actual !== expectedOutcome(tier, actionClass)) {
      matrixFailures += 1
      console.log(`        ${tier} + ${tool}: expected ${expectedOutcome(tier, actionClass)}, got ${actual}`)
    }
  }
}
check('12 工具 × 3 档矩阵与规范一致', matrixFailures === 0, `${matrixFailures} mismatched cell(s)`)
{
  const customCase = PLAIN_DEPLOYMENT.resolve(sessionWith(...presetEvents('danger-full-access', 'read-only', 'ask')))
  check(
    'custom 折叠后矩阵等同最严档位',
    customCase.kind === 'solved' && customCase.value === 'custom'
      && decideCall(gatingTierOf(customCase), 'mutate').kind === 'deny'
      && decideCall(gatingTierOf(customCase), 'navigate').kind === 'deny'
      && decideCall(gatingTierOf(customCase), 'read').policy === 'auto',
    `got ${JSON.stringify(customCase)}`,
  )
}
check(
  '拒绝时携带动作类别供文案使用',
  decideCall('read-only', 'navigate').actionClass === 'navigate',
  'the deny verdict must identify what was refused',
)
check(
  'policyFor 对读与观测恒为 auto',
  policyFor('read-only', 'read') === 'auto' && policyFor('read-only', 'observe') === 'auto',
  'reading and observing are never gated by the tier',
)

// ---------------------------------------------------------------------------
// Part 2: the change/downgrade reactions, driven by a fake projection feed.
// ---------------------------------------------------------------------------
const watch = await import(pathToFileURL(build('packages/bridge-dsh/src/permission-watch.ts', 'watch')).href)
const { watchPermissionTiers } = watch

/**
 * Drive the watcher through a mutable session log.
 *
 * The watcher rides `session/event`, so a tier switch is simulated by swapping
 * the log and delivering the knob event that caused it.
 */
function makeFeed(events = []) {
  const session = { id: 'sess-1', snapshotEvents: () => feed.events }
  const feed = {
    events,
    session,
    /** Deliver one appended event, as dsh's session/event feed does. */
    fire(event = { type: 'sandbox/mode', data: { mode: 'workspace-write' } }) { feed.observe(session, event) },
    observe: null,
    deps(overrides = {}) {
      return {
        // Gating without a projection second opinion: these assertions are about
        // the watcher's change/downgrade logic, and the cross-check has its own.
        permissions: { gatedTier: (s) => gatingTierOf(PLAIN_DEPLOYMENT.resolve(s)) },
        announce: () => {},
        withdraw: () => 0,
        log: () => {},
        ...overrides,
      }
    },
  }
  return feed
}

{
  const feed = makeFeed(presetEvents('workspace-write', 'workspace-write', 'ask'))
  const announced = []
  const withdrawn = []
  feed.observe = watchPermissionTiers(feed.deps({
    announce: (id, value) => announced.push(`${id}:${value}`),
    withdraw: (id) => { withdrawn.push(id); return 2 },
  }))
  feed.fire()
  check(
    '首次见到档位不推送（基线而非变化）',
    announced.length === 0,
    `got ${JSON.stringify(announced)} — a first sighting must not announce`,
  )
  feed.fire({ type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  check(
    '档位未变化不推送',
    announced.length === 0,
    'a repeated identical value must not produce a frame',
  )
  feed.events = presetEvents('danger-full-access', 'danger-full-access', 'never')
  feed.fire({ type: 'permission/preset', data: { preset: 'danger-full-access' } })
  check(
    '档位上升时推送但不撤回在途调用',
    announced.length === 1 && announced[0] === 'sess-1:danger-full-access' && withdrawn.length === 0,
    `announced=${JSON.stringify(announced)} withdrawn=${JSON.stringify(withdrawn)}`,
  )
  feed.events = presetEvents('read-only', 'read-only', 'ask')
  feed.fire({ type: 'sandbox/mode', data: { mode: 'read-only' } })
  check(
    '档位下降时推送并撤回该会话在途调用',
    announced.length === 2 && withdrawn.length === 1 && withdrawn[0] === 'sess-1',
    `announced=${JSON.stringify(announced)} withdrawn=${JSON.stringify(withdrawn)}`,
  )
}

{
  // The watcher must announce the tier the GATE will use, not the raw fold. A
  // cross-check tightening is exactly the case where those differ, and telling
  // the panel one tier while judging calls by another is the drift this whole
  // change exists to remove.
  //
  // The projection is mutable so the divergence can APPEAR after a healthy
  // baseline — which is what a real deployment narrowing the tier looks like.
  const projection = { options: TIERS, currentValue: 'workspace-write' }
  const feed = makeFeed(presetEvents('workspace-write', 'workspace-write', 'ask'))
  const tightened = []
  const live = servicesOf(projection, undefined, () => {})
  feed.observe = watchPermissionTiers(feed.deps({
    permissions: { gatedTier: (sess) => live.gatedTier(sess) },
    announce: (id, value) => tightened.push(`${id}:${value}`),
  }))
  feed.fire()
  // The log moves to full access while the projection says read-only.
  feed.events = presetEvents('danger-full-access', 'danger-full-access', 'never')
  projection.currentValue = 'read-only'
  feed.fire({ type: 'permission/preset', data: { preset: 'danger-full-access' } })
  check(
    '推送的是 gate 实际使用的档位（含核对收紧），而非原始折叠值',
    tightened.length === 1 && tightened[0] === 'sess-1:read-only',
    `announced=${JSON.stringify(tightened)}; the panel must be told what the gate enforces`,
  )
}

{
  // A non-knob event is not this watcher's business. The feed is driven with
  // other event types while the tier genuinely changes — if the filter were
  // missing, these would announce and withdraw.
  const feed = makeFeed(presetEvents('workspace-write', 'workspace-write', 'ask'))
  let announced = 0
  let withdrawn = 0
  feed.observe = watchPermissionTiers(feed.deps({
    announce: () => { announced += 1 },
    withdraw: () => { withdrawn += 1; return 1 },
  }))
  feed.fire({ type: 'session/created', data: {} })
  feed.events = presetEvents('danger-full-access', 'danger-full-access', 'never')
  feed.fire({ type: 'assistant/message', data: {} })
  feed.events = presetEvents('read-only', 'read-only', 'ask')
  feed.fire({ type: 'tool/result', data: {} })
  check(
    '无关会话事件被忽略',
    announced === 0 && withdrawn === 0,
    `announced ${announced}, withdrawn ${withdrawn} for non-knob events`,
  )
}

{
  // A solve that FAILS must not be read as a downgrade: withdrawing calls the
  // user may still be authorized for would be a real-world side effect caused by
  // a bookkeeping failure.
  const feed = makeFeed(presetEvents('danger-full-access', 'danger-full-access', 'never'))
  let announced = 0
  let withdrawn = 0
  feed.observe = watchPermissionTiers(feed.deps({
    announce: () => { announced += 1 },
    withdraw: () => { withdrawn += 1; return 1 },
  }))
  feed.fire()
  feed.events = [{ seq: 0, type: 'sandbox/mode', data: { mode: 'wide-open' } }]
  feed.fire({ type: 'sandbox/mode', data: { mode: 'wide-open' } })
  check(
    '求解失败不当作档位下降（不撤回在途调用）',
    announced === 0 && withdrawn === 0,
    `announced ${announced}, withdrawn ${withdrawn}; a failed solve must not withdraw authorized calls`,
  )
  // Forgetting the baseline means the next real value is a BASELINE again, not a
  // change: pushing it would announce a tier the panel already displays.
  feed.events = presetEvents('read-only', 'read-only', 'ask')
  feed.fire({ type: 'approval/policy', data: { policy: 'ask' } })
  check(
    '求解恢复后按新基线处理（不推送）',
    announced === 0 && withdrawn === 0,
    `announced ${announced}, withdrawn ${withdrawn}`,
  )
  // A change observed AFTER that baseline is announced as usual.
  feed.events = presetEvents('danger-full-access', 'danger-full-access', 'never')
  feed.fire({ type: 'permission/preset', data: { preset: 'danger-full-access' } })
  check(
    '恢复基线之后的再次变化仍被推送',
    announced === 1 && withdrawn === 0,
    `announced=${announced} withdrawn=${withdrawn}`,
  )
}

// ---------------------------------------------------------------------------
// Part 3: the extension's gate — including the absent-policy fallback.
// ---------------------------------------------------------------------------
const authorization = await import(
  pathToFileURL(build('packages/extension/src/background/authorization.ts', 'authorization')).href
)
const { gateToolCall, isPageRead } = authorization

const actionCall = { id: '1', name: 'browser_click', args: { index: 3 }, expiresAt: 1 }
const navigateCall = { id: '2', name: 'browser_navigate', args: { url: 'https://example.com' }, expiresAt: 1 }
const readCall = { id: '3', name: 'browser_snapshot', args: {}, expiresAt: 1 }
const observeCall = { id: '4', name: 'browser_scroll', args: { direction: 'down' }, expiresAt: 1 }

check(
  'auto 策略下状态变更不产生审批请求',
  gateToolCall(actionCall, 'auto', 'auto', []) === undefined,
  'full access must not raise a dialog',
)
check(
  'auto 策略下开新标签页不产生审批请求',
  gateToolCall({ id: '5', name: 'browser_open_tab', args: { url: 'https://example.com' }, expiresAt: 1 }, 'auto', 'auto', []) === undefined,
  'the open-tab path must honor the same policy',
)
check(
  'ask 策略下状态变更产生审批请求',
  gateToolCall(actionCall, 'ask', 'auto', [])?.kind === 'action',
  'workspace-write must raise the write dialog',
)
check(
  '策略缺失按最严处理（产生审批请求）',
  gateToolCall(actionCall, undefined, 'auto', [])?.kind === 'action',
  'an older bridge must not open an unconfirmed action window',
)
check(
  'auto 策略下读取不产生审批请求',
  gateToolCall(readCall, 'auto', 'ask', []) === undefined,
  'a permissive tier must not turn an allowed read into a prompt',
)
check(
  'ask 策略下读取按分享偏好决定',
  gateToolCall(readCall, 'ask', 'ask', [])?.kind === 'read',
  'the sharing preference still governs reads under the asking tier',
)
check(
  '观测类调用在任何档位下都无审批请求',
  gateToolCall(observeCall, 'ask', 'auto', []) === undefined
    && gateToolCall(observeCall, undefined, 'auto', []) === undefined,
  'scroll/wait change neither page nor tab state',
)
check(
  '页面读取的判别只看快照与读文本',
  isPageRead('browser_snapshot') && isPageRead('browser_get_text')
    && !isPageRead('browser_click') && !isPageRead('browser_scroll'),
  'the sharing boundary must apply to exactly the page-reading tools',
)

// ---------------------------------------------------------------------------
// Part 4: artifact and vocabulary consistency.
//
// These are static facts that a live run would otherwise be trusted to imply:
// the panel must name tiers exactly as dsh names them (the whole point of the
// alignment), the new controls must exist in the BUILT panel (a source-only
// control that never reached dist/ is the classic false pass), and the plugin
// artifact the running dsh loads must be the one this checkout built.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/** dsh's own tier labels, copied from its locale dictionary. */
const DSH_LABELS = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
}
const selectorSource = readFileSync(
  join(repoRoot, 'packages/extension/src/panel/permission-selector.ts'), 'utf8')
for (const [tier, label] of Object.entries(DSH_LABELS)) {
  check(
    `面板标签与 dsh 一致：${tier} → ${label}`,
    selectorSource.includes(`'${tier}': '${label}'`),
    `the panel must label ${tier} exactly as dsh does`,
  )
}

const panelHtml = readFileSync(join(repoRoot, 'packages/extension/panel/index.html'), 'utf8')
const builtHtml = readFileSync(join(repoRoot, 'packages/extension/dist/panel/index.html'), 'utf8')
for (const id of ['permissionSelect', 'permissionLock', 'fullAccessOverlay', 'fullAccessAck', 'settingsSharing']) {
  check(
    `构建后的面板含控件 #${id}`,
    panelHtml.includes(`id="${id}"`) && builtHtml.includes(`id="${id}"`),
    'a control present only in source never reaches the browser',
  )
}

// The panel bundle must actually carry the selector module, not just the HTML.
const builtPanelJs = readFileSync(join(repoRoot, 'packages/extension/dist/panel/panel.js'), 'utf8')
check(
  '构建后的面板 JS 含档位选择器逻辑',
  builtPanelJs.includes('permissionSelect') && builtPanelJs.includes('permission.set'),
  'the selector markup without its module would render but never work',
)
const builtBackground = readFileSync(join(repoRoot, 'packages/extension/dist/background.js'), 'utf8')
check(
  '构建后的扩展后台按帧内策略执行、且不自行拒绝',
  builtBackground.includes('gateToolCall') && builtBackground.includes('DEFAULT_TOOL_CALL_POLICY')
    && !builtBackground.includes('permission-tier-denied'),
  'the background must apply the bridge policy verbatim; denial belongs to the bridge before the frame',
)

// The profile copy is what a running dsh loads; a workspace build alone does
// not reach it (scripts/sync-profile.sh exists for exactly this reason).
const builtLib = join(repoRoot, 'packages/bridge-dsh/lib/index.js')
const profileLib = join(homedir(), '.dsh/profiles/web/node_modules/bridge-dsh/lib/index.js')
if (existsSync(profileLib)) {
  const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  check(
    'profile 中的桥接产物与本次构建一致',
    digest(builtLib) === digest(profileLib),
    'run: bash packages/bridge-dsh/build.sh && bash scripts/sync-profile.sh web',
  )
} else {
  console.log('SKIP  profile 桥接产物比对\n        no installed copy at ~/.dsh/profiles/web')
}

// The replay race guard: a tier announced while a history replay is in flight
// must be HELD, because the replay ends by adopting a projection computed
// before that announcement. Applying it eagerly would let the stale baseline
// overwrite it, and nothing re-announces a value that already changed.
check(
  '面板在重放期间暂存档位通告（避免被更旧的投影基线覆盖）',
  selectorSource.includes('flushDeferred')
    && selectorSource.includes('deferred = { sessionId: payload.sessionId, value: payload.value }'),
  'the announcement must be held during a replay, not applied eagerly',
)
const mainSource = readFileSync(join(repoRoot, 'packages/extension/src/panel/main.ts'), 'utf8')
const bgSource = readFileSync(join(repoRoot, 'packages/extension/src/background/index.ts'), 'utf8')
// A session can be bound without any history read (the panel's `ensureSession`
// creates one for the first send or the first model pick, and only `openSession`
// replays history). The tier lives in that session's projection, so the bind
// notification MUST trigger a read — otherwise the control reports "no tier"
// for a session that has one, for that session's entire first turn.
// Opening the panel must not litter dsh's session list. The deployment-tier read
// is a `session.list` (read-only), and the only `ensureSession` call sits behind
// a user selection — so merely rendering the control cannot create a session.
/**
 * Extract one function body by brace matching, so "this function never calls X"
 * is asserted against the real body rather than a fixed-size window.
 * @param source - module source text.
 * @param name - function name to locate.
 * @returns the body text, or empty when not found.
 */
function functionBodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return ''
}
const renderBody = functionBodyOf(selectorSource, 'renderPermissionRow')
const loadBody = functionBodyOf(selectorSource, 'loadDeploymentTiers')
// A rebuilt bundle is not a reloaded one: dsh keeps serving the module it loaded
// at startup, so a bridge can advertise tiers (the projection is dsh's own) while
// its RPC surface predates them. The control must stop offering switches then,
// because every retry can only reproduce the same refusal.
check(
  '桥接不支持切换时控件不再提供切换（并说明需重载插件）',
  selectorSource.includes('switchUnsupported')
    && selectorSource.includes("code === 'not-found'")
    && selectorSource.includes('需重载 dsh 插件'),
  'an unsupported bridge must disable the control with an actionable message',
)
check(
  '重连时重新探测支持情况（重载插件即可恢复）',
  /setConnected\(value: boolean\)[\s\S]{0,220}switchUnsupported = false/.test(selectorSource),
  'a reconnect must clear the cached "unsupported" verdict',
)
check(
  '打开面板不因档位控件而创建会话',
  renderBody !== '' && loadBody !== ''
    && !renderBody.includes('ensureSession')
    && !loadBody.includes('ensureSession')
    && loadBody.includes("'session.list'"),
  `render=${renderBody.length}B load=${loadBody.length}B`
    + ` renderCreates=${renderBody.includes('ensureSession')} loadCreates=${loadBody.includes('ensureSession')}`,
)
check(
  '会话绑定时主动读取档位（覆盖新建会话无历史重放的路径）',
  mainSource.includes('permissionSelector.loadForSession(sessionId)')
    && selectorSource.includes('export function loadForSession')
    && selectorSource.includes("rpc<unknown>('session.history'"),
  'the bind listener must trigger a tier read, and the loader must issue it',
)
check(
  '档位读取结果按会话校验后才应用（切换后不串档）',
  selectorSource.includes('getActiveSessionId() !== sessionId') && selectorSource.includes('hasSession()'),
  'a read that lands after a session switch must be discarded',
)
check(
  '重放结束后冲刷暂存的档位通告',
  mainSource.includes('permissionSelector.flushDeferred()')
    && mainSource.includes('permissionSelector.applyPermissionEvent(f.payload, conversation.isReplaying())'),
  'the held frame must be applied once the baseline is in place',
)

// --- the two axes are structurally decoupled ---
// Independence is not merely a promise here: the sharing preference is a local
// storage value written through its own panel message, while the tier lives in
// the dsh session projection. Neither path can reach the other, which is what
// makes "changing one never changes the other" checkable without a browser.
// Anchor on the case label itself, then take the block up to its closing brace.
const sharingStart = bgSource.lastIndexOf("case 'page-sharing.set': {")
const sharingHandler = sharingStart < 0
  ? ''
  : bgSource.slice(sharingStart, bgSource.indexOf('\n      }', sharingStart) + 8)
check(
  '页面分享写入不触碰桥（不改变会话档位）',
  sharingHandler !== ''
    // Assert on the CODE, not on prose: the handler's own comment explains the
    // independence and legitimately contains the word "permission".
    && !/permission\.set|rpc\s*\(|bridge\?\./.test(sharingHandler.replace(/\/\/[^\n]*/g, ''))
    && sharingHandler.includes('persistSettings'),
  `the privacy axis must be a local write only; got:\n${sharingHandler.slice(0, 240)}`,
)
check(
  '后台不为档位保存任何本地状态',
  !/sharePageContent[\s\S]{0,80}(read-only|workspace-write|danger-full-access)/.test(bgSource)
    && !bgSource.includes('permission.set'),
  'the background must not derive or store a tier locally',
)
// The tab URL/title shown in the panel come from `chrome.tabs` metadata, not
// from page content, so the sharing preference must not suppress them — a user
// with sharing off still needs to see which page the agent is pointed at.
check(
  '标签页元信息不受分享偏好影响',
  /activePage = \{ url: tab\.url, title: tab\.title/.test(bgSource)
    && !/sharePageContent[\s\S]{0,120}activePage/.test(bgSource.replace(/\/\/[^\n]*/g, ''))
    && bgSource.includes('activePage,'),
  'tab metadata must stay independent of the page-content sharing preference',
)
// The panel posts the preference; this asserts the receiving end persists it and
// that every tool call reads the persisted value — the round trip that makes
// "changed and took effect" more than "a message was sent".
check(
  '分享偏好落盘且被工具调用读取（消息→存储→判定闭环）',
  /persistSettings\(\{\s*sharePageContent:/.test(sharingHandler)
    && /sharePageContent:\s*raw\.sharePageContent/.test(bgSource)
    && (bgSource.match(/settings\.sharePageContent/g) ?? []).length >= 3,
  'the message must persist the value, and the gate must read the persisted one',
)

// ---------------------------------------------------------------------------
// Part 5: the panel selector, driven headlessly through a stub DOM.
//
// The module resolves its handles inside initPermissionSelector precisely so
// this is possible (the same reason initSlashCommand exists): the tier rules —
// candidate sourcing, dsh label parity, `custom` handling, the disabled state —
// are asserted here instead of only in a browser.
// ---------------------------------------------------------------------------
/**
 * Stub panel port.
 *
 * Messages are recorded per port so a test can tell the settings dialog's port
 * from the transport's; the transport's inbound listener is captured so an
 * `rpc.result` can be delivered back, which is how panel RPC calls are driven
 * without a background worker.
 */
const panelPorts = []
function makePort() {
  const record = { sent: [], inbound: null }
  panelPorts.push(record)
  return {
    onMessage: { addListener: (fn) => { record.inbound = fn } },
    onDisconnect: { addListener() {} },
    postMessage: (message) => { record.sent.push(message) },
  }
}
globalThis.chrome = { runtime: { connect: makePort } }

const domNodes = new Map()
const domListeners = new Map()
function stubNode(id) {
  return {
    id,
    textContent: '',
    value: '',
    disabled: false,
    title: '',
    className: '',
    checked: false,
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    appendChild(child) { this.children.push(child) },
    append(child) { this.children.push(child) },
    replaceChildren() { this.children = [] },
    setAttribute(key, val) { this[key] = val },
    querySelector() { return null },
    contains() { return false },
    addEventListener(type, fn) { domListeners.set(`${id}:${type}`, fn) },
    focus() {},
    scrollIntoView() {},
  }
}
globalThis.document = {
  getElementById: (id) => {
    if (!domNodes.has(id)) domNodes.set(id, stubNode(id))
    return domNodes.get(id)
  },
  addEventListener() {},
  createElement: () => stubNode('created'),
}
globalThis.Node = class {}

const panel = await import(
  pathToFileURL(build('packages/extension/src/panel/permission-selector.ts', 'selector')).href
)
// Read the node by id at assertion time: the stub caches per id, so this is the
// same object the module holds, and a captured reference cannot go stale.
// Complete the transport wiring a check would otherwise lack: the panel's
// main.ts installs this switch, and without it inbound rpc.result frames are
// dropped on the floor (the transport forwards only to that listener).
panel.setMessageListener((message) => { deliveredInbound.push(message) })
const deliveredInbound = []
const selectNode = () => domNodes.get('permissionSelect')
/** Render one projection and read back the rendered option rows. */
function renderWith(view, { connected = true, session = null } = {}) {
  panel.initPermissionSelector()
  // State the session premise explicitly. The probe binds globally, so without
  // this a session bound by an earlier case would leak into the next.
  panel.setSessionProbeForTest(session)
  // The panel clears the display on a session switch before applying the new
  // session's baseline; doing the same here keeps each case independent, so a
  // projection carrying no tier cannot inherit the previous case's rows.
  panel.resetTier()
  panel.setConnected(connected)
  panel.alignFromProjections({ projections: { values: { permissions: view } } })
  // Snapshot the whole control here: a later case rebinds the session and
  // re-renders globally, so reading the live node after the fact would report
  // whichever case ran last.
  return {
    rows: (selectNode()?.children ?? []).map(child => ({
      text: child.textContent ?? child.text,
      value: child.value,
      selected: child.selected === '',
      disabled: child.disabled === '',
    })),
    title: selectNode()?.title ?? '',
    disabled: selectNode()?.disabled === true,
  }
}

{
  const { rows } = renderWith({
    currentValue: 'workspace-write',
    options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }],
  })
  check(
    '标准三档按 dsh 标签渲染',
    rows.map(r => r.text).join('|') === '仅可查看|工作区内修改|完全权限',
    `got ${JSON.stringify(rows.map(r => r.text))}`,
  )
  check(
    '当前档位被标记为选中',
    rows.find(r => r.value === 'workspace-write')?.selected === true
      && rows.filter(r => r.selected).length === 1,
    `got ${JSON.stringify(rows)}`,
  )
  check(
    '档位控件带浏览器作用范围提示',
    selectNode()?.title.includes('工作区内修改') && selectNode()?.title.includes('人工确认'),
    `title was ${JSON.stringify(selectNode()?.title)}`,
  )
}

{
  const { rows } = renderWith({
    currentValue: 'workspace-write',
    options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }],
  })
  check(
    '候选来自投影而非硬编码（部署未给的档位不出现）',
    rows.map(r => r.value).join('|') === 'workspace-write|danger-full-access',
    `got ${JSON.stringify(rows.map(r => r.value))}`,
  )
}

{
  // A session created by the panel's own first send is bound BEFORE any history
  // read, so its tier projection has not arrived yet. That is NOT the same as a
  // deployment without tiers: dead-ending the control there would leave a fresh
  // session's permission unchangeable from the panel for its whole first turn.
  // A session IS bound but no tier value has been read yet. The fixture is the
  // realistic shape: dsh publishes the preset LIST even when it cannot name the
  // session's current one (knobs matching no preset), which is exactly when the
  // old code dead-ended the control.
  const bound = renderWith(
    { options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }] },
    { session: 'sess-check' },
  )
  check(
    '会话已绑定但档位投影未到：候选仍可用而非死锁',
    bound.rows.length > 0 && bound.rows.every(r => r.text !== '权限不可用'),
    `got ${JSON.stringify(bound.rows)}`,
  )
  check(
    '档位投影未到时提示「读取中」而非谎报能力缺失',
    bound.title.includes('读取本会话权限'),
    `title was ${JSON.stringify(bound.title)}`,
  )
}

{
  // A session that does have a tier keeps showing it — the no-tier branch above
  // must not have swallowed the normal path.
  const { rows } = renderWith({ currentValue: 'read-only', options: [{ value: 'read-only' }] })
  check(
    '有档位投影时正常显示当前档位',
    rows.length === 1 && rows[0].text === '仅可查看',
    `got ${JSON.stringify(rows)}`,
  )
}


{
  // No session bound at all (a panel before its first send) and no tier data:
  // there is nothing to address a switch to, so the control must be inert.
  const { rows } = renderWith({})
  check(
    '无会话且无档位数据时控件不可用',
    rows.length === 1 && rows[0].text === '权限不可用',
    `rows=${JSON.stringify(rows)}`,
  )
}

{
  // "New session" state with the deployment's tier list known — the case the
  // user needs: configure the tier before anything has been sent. The list
  // reaches the module through the same parser the `session.list` read uses;
  // only the fetch is bypassed, because a stub port cannot complete an rpc round
  // trip here (the transport forwards inbound frames only to the listener
  // `main.ts` installs, and that switch is not reachable from a bundle of this
  // module alone).
  panel.resetTier()
  panel.setSessionProbeForTest('')
  panel.setConnected(true)
  panel.setDeploymentTiersForTest([
    { value: 'read-only' }, { value: 'workspace-write' }, { value: 'strict-audit' },
  ])
  const fresh = {
    rows: (selectNode()?.children ?? []).map(c => c.textContent ?? c.text),
    title: selectNode()?.title ?? '',
    disabled: selectNode()?.disabled === true,
  }
  check(
    '新会话状态：无需先发消息即可看到候选档位',
    fresh.rows.includes('仅可查看') && fresh.rows.includes('工作区内修改'),
    `rows=${JSON.stringify(fresh.rows)}`,
  )
  check(
    '新会话状态的候选同样不硬编码（只列部署公布的名字）',
    fresh.rows.includes('strict-audit') && fresh.rows.length === 3,
    `rows=${JSON.stringify(fresh.rows)}`,
  )
  check(
    '新会话状态：提示选定后会创建会话并生效',
    fresh.title.includes('新会话') || fresh.title.includes('创建会话'),
    `title=${JSON.stringify(fresh.title)} rows=${JSON.stringify(fresh.rows)}`,
  )
  check(
    '新会话状态不伪装已选中档位（无会话即无当前值）',
    !(selectNode()?.children ?? []).some(c => c.selected === '' || c.selected === true),
    'no option may be marked selected when no session exists yet',
  )
  check(
    '新会话状态下控件可交互（这正是「先配置」的前提）',
    fresh.disabled === false,
    'the control must be selectable so a tier can be configured up front',
  )
  panel.setDeploymentTiersForTest([])
}

{
  const { rows } = renderWith({
    currentValue: 'strict-audit',
    options: [{ value: 'strict-audit' }],
  })
  check(
    '部署自定义预设名不被臆造成标准档位名',
    rows.length === 1 && rows[0].text === 'strict-audit',
    `got ${JSON.stringify(rows)}`,
  )
}

{
  const { rows } = renderWith({
    currentValue: 'custom',
    options: [{ value: 'read-only' }, { value: 'custom' }],
  })
  check(
    'custom 如实显示为「自定义」而非归入某一档',
    rows.find(r => r.value === 'custom')?.text === '自定义',
    `got ${JSON.stringify(rows)}`,
  )
  check(
    'custom 呈不可选状态',
    rows.find(r => r.value === 'custom')?.disabled === true,
    `got ${JSON.stringify(rows)}`,
  )
  const customDisabled = rows.find(r => r.value === 'custom')?.disabled === true
  const normalEnabled = rows.find(r => r.value === 'read-only')?.disabled === false
  check(
    '标准档位仍可选（只有 custom 被禁）',
    customDisabled && normalEnabled,
    `got ${JSON.stringify(rows)}`,
  )
}

{
  const idle = renderWith(undefined, { connected: false })
  check(
    '未连接时控件禁用且不列候选',
    idle.disabled && idle.rows.length === 1,
    `disabled=${idle.disabled} rows=${JSON.stringify(idle.rows)}`,
  )
}

{
  // A projection with neither options nor a current value means the deployment
  // exposes no tier at all: the control must say so rather than show an empty
  // picker, and must not fall back to a hardcoded list.
  const { rows } = renderWith({ options: [] })
  check(
    '部署无档位能力时显示「权限不可用」而非空列表',
    selectNode()?.disabled === true && rows.length === 1 && rows[0].text === '权限不可用',
    `disabled=${selectNode()?.disabled} rows=${JSON.stringify(rows)}`,
  )
}

{
  // resetTier clears the display on a session switch, and the guard means a
  // held announcement from the previous session must not resurface.
  panel.setConnected(true)
  renderWith({ currentValue: 'danger-full-access', options: [{ value: 'danger-full-access' }] }, { session: 'sess-check' })
  panel.resetTier()
  const afterReset = (selectNode()?.children ?? []).map(c => c.textContent ?? c.text)
  check(
    '切换会话时清空上一会话的档位显示',
    selectNode()?.disabled === true && !afterReset.includes('完全权限'),
    `after reset rows=${JSON.stringify(afterReset)}`,
  )
}

// ---------------------------------------------------------------------------
// Part 6: the sharing preference control (the privacy axis), driven headlessly.
//
// `settings.ts` reads its handles at module scope, so the stub DOM and the
// panel port must both exist BEFORE it is imported — the port because the panel
// transport opens a `chrome.runtime` connection.
// ---------------------------------------------------------------------------

const settings = await import(
  pathToFileURL(build('packages/extension/src/panel/settings.ts', 'settings')).href
)

{
  settings.initSettings()
  const sharingSelect = domNodes.get('settingsSharing')
  check(
    '配置弹框含页面分享控件且被初始化',
    sharingSelect !== undefined,
    'initSettings must resolve the sharing control',
  )

  // The control must reflect whatever is actually persisted — including a value
  // written by the approval dialog's "always allow reads", which is the change
  // this control exists to make visible and revocable.
  settings.setPageSharing('off')
  check(
    '分享控件反映外部写入的偏好（总是允许读取后可被看见）',
    sharingSelect.value === 'off',
    `control showed ${JSON.stringify(sharingSelect.value)}`,
  )
  settings.setPageSharing('ask')
  check(
    '分享控件可撤销回「每次询问」',
    sharingSelect.value === 'ask',
    `control showed ${JSON.stringify(sharingSelect.value)}`,
  )

  // A value outside the vocabulary must not become a stored preference.
  settings.setPageSharing('nonsense')
  check(
    '未知分享值被收敛为默认「自动」而非原样保留',
    sharingSelect.value === 'auto',
    `control showed ${JSON.stringify(sharingSelect.value)}`,
  )

  // Changing the control must apply immediately (on change, not on save) and
  // must travel as the sharing message — not as a settings save, which would
  // restart the bridge for a purely local preference.
  sharingSelect.value = 'off'
  const before = panelPorts.reduce((n, port) => n + port.sent.length, 0)
  domListeners.get('settingsSharing:change')?.()
  // The settings dialog owns its own port, created on first post.
  const dialogPort = panelPorts.find(port => port.sent.some(m => m.type === 'page-sharing.set'))
  check(
    '改变分享偏好立即发出 page-sharing.set（不等保存）',
    dialogPort?.sent.find(m => m.type === 'page-sharing.set')?.value === 'off',
    `posted ${JSON.stringify(panelPorts.map(port => port.sent))}`,
  )
  check(
    '改变分享偏好不触发设置保存（不重连桥）',
    !panelPorts.some(port => port.sent.some(m => m.type === 'settings')),
    `posted ${JSON.stringify(panelPorts.map(port => port.sent))}`,
  )
  check(
    '本次交互只发出分享消息（未顺带发别的）',
    panelPorts.reduce((n, port) => n + port.sent.length, 0) - before === 1,
    `delta ${panelPorts.reduce((n, port) => n + port.sent.length, 0) - before}`,
  )
}

// ---------------------------------------------------------------------------
// Part 7: the model-side tier narration registration.
//
// dsh's `systemPrompt.context` validates its entry, and an `order` that is not
// a finite number throws. That throw happens inside the plugin's `apply()`,
// where app-boot turns it into a REFUSED dsh start rather than a missing
// sentence — the failure mode this part exists to prevent. A "missing service"
// check cannot see it: that path returns before any registration happens.
// ---------------------------------------------------------------------------
const narration = await import(pathToFileURL(build('packages/bridge-dsh/src/tier-narration.ts', 'narration')).href)
const { registerTierNarration, TIER_NARRATION_NAME, TIER_NARRATION_ORDER } = narration

/** A fake host system-prompt service that records what gets registered. */
function makeSystemPrompt() {
  const entries = []
  let disposals = 0
  return {
    entries,
    get disposals() { return disposals },
    context(entry) { entries.push(entry); return () => { disposals += 1 } },
  }
}

/**
 * Register against a mutable session log; hand back the recorded entry.
 *
 * `state.events` is reassigned to simulate a tier switch — the narration
 * re-solves on every request, so reassignment is exactly what a new knob event
 * would do to it.
 */
function registerWith(state) {
  const systemPrompt = makeSystemPrompt()
  const effects = []
  registerTierNarration({
    systemPrompt,
    permissions: { resolve: () => PLAIN_DEPLOYMENT.resolve({ id: 'sess-1', snapshotEvents: () => state.events }) },
    effect: (register, name) => { effects.push({ name, dispose: register() }) },
  })
  return { systemPrompt, effects, entry: systemPrompt.entries[0] }
}

{
  const session = { id: 'sess-1' }
  const state = { events: presetEvents('read-only', 'read-only', 'ask') }
  const { systemPrompt, effects, entry } = registerWith(state)

  check(
    '有系统提示词能力时恰好注册一个播报上下文',
    systemPrompt.entries.length === 1 && entry?.name === TIER_NARRATION_NAME,
    `entries=${JSON.stringify(systemPrompt.entries.map(e => e.name))}`,
  )
  check(
    '播报上下文带有限 order（非法 order 会让 dsh 拒绝启动）',
    typeof entry?.order === 'number' && Number.isFinite(entry.order),
    `order=${String(entry?.order)}`,
  )
  check(
    '播报 order 落在 dsh 政策播报带内（110 sandbox / 115 approval / 120 subagent 之间）',
    entry?.order === TIER_NARRATION_ORDER && entry.order > 115 && entry.order < 120,
    `order=${String(entry?.order)}`,
  )
  check(
    '播报经 effect 注册（禁用或重载插件时注销）',
    effects.length === 1 && effects[0].name === 'bridge-dsh: browser tier narration'
      && typeof effects[0].dispose === 'function' && typeof entry?.text === 'function',
    `effects=${JSON.stringify(effects.map(e => e.name))}`,
  )

  const readOnlyText = entry.text({ agent: { session } })
  check(
    '只读档播报说明改页面与开网站会被拒绝',
    /are refused/.test(readOnlyText) && /ask the user to raise the tier/.test(readOnlyText),
    readOnlyText,
  )
  check(
    '无会话的请求不播报任何策略',
    entry.text({}) === '' && entry.text({ agent: {} }) === '',
    `empty=${JSON.stringify(entry.text({}))}`,
  )

  state.events = presetEvents('danger-full-access', 'danger-full-access', 'never')
  const fullText = entry.text({ agent: { session } })
  check(
    '播报按每次请求重新求值（切档后不残留只读限制）',
    fullText !== readOnlyText && !/are refused/.test(fullText) && /without an approval/.test(fullText),
    fullText,
  )

  state.events = presetEvents('workspace-write', 'workspace-write', 'ask')
  const writeText = entry.text({ agent: { session } })
  check(
    '可操作档播报说明写操作需人工确认',
    /requires a human approval/.test(writeText),
    writeText,
  )

  state.events = []
  check(
    '档位能力不可用时播报为空（不宣称部署未强制的策略）',
    entry.text({ agent: { session } }) === '',
    `text=${JSON.stringify(entry.text({ agent: { session } }))}`,
  )
}

{
  const effects = []
  registerTierNarration({
    systemPrompt: undefined,
    permissions: { resolve: () => ({ kind: 'unresolved', reason: 'no-preset-table', options: [] }) },
    effect: (register, name) => { effects.push(name); register() },
  })
  check(
    '缺失系统提示词能力时不注册也不抛错',
    effects.length === 0,
    `effects=${JSON.stringify(effects)}`,
  )
}

// ---------------------------------------------------------------------------
// Part 8: spec coverage accounting.
//
// Every scenario in the change's deltas must be classified: decided here by a
// pure check, or explicitly deferred to the live run. A scenario that is in
// neither bucket is the failure this part exists to catch — silent gaps are
// how a change looks verified while a requirement was never exercised.
// ---------------------------------------------------------------------------
const DECIDED_HERE = new Set([
  // browser-permission-tiers
  '从投影求解档位', 'custom 按最严档位处理', '部署无权限能力时按默认档位处理',
  '仅可查看下状态变更被拒', '仅可查看下开新标签页被拒', '仅可查看下读取与观测放行',
  '可操作下放行并要求确认', '完全权限下不产生审批请求',
  '扩展不能自证档位', '扩展不能覆盖帧内档位', '无档位帧按最严处理',
  '未知档位名被拒', 'custom 不可作为切换目标', '不直写单个旋钮',
  '无系统提示词能力时跳过', '降级后工具照常可用',
  // panel-permission-selector
  '标准三档显示 dsh 标签', '部署自定义预设不臆造标签', '档位附带浏览器作用范围说明',
  '自定义档位如实显示', '自定义不可被再次选中', '面板不直写会话权限',
  '候选来自投影而非硬编码', '未连接时禁用',
  // bridge-tier-source-of-truth — decided by the fold/gate assertions in Part 1
  '从会话旋钮事件求解档位', '同一会话内求解结果稳定',
  '自定义预设名不按最严档位判定', 'custom 按最严档位处理',
  '求解失败时不折算为档位', '部署确实无档位能力时才按无能力处理',
  '失败留痕且可定位', '失败不被表述为档位拒绝',
  '新会话状态下即可预先配置档位', '新会话状态下选定档位即创建会话并生效',
  '新会话状态不伪装已选中', '打开面板不因档位控件而创建会话',
  '桥接未重载时给出可执行说明', '重载插件后自动恢复',
  // panel-page-sharing-setting
  '改分享不影响档位', '总是允许读取后控件同步',
  '控件呈现实际偏好', '改变即持久化并生效', '撤销总是允许读取',
  '只读档叠加关闭分享仍可读标签页元信息',
])
const DEFERRED_TO_LIVE = new Map([
  ['合法切换生效', '9.4 — 需要 dsh 会话真正切换并观察后续调用'],
  ['模型侧的档位播报', '9.4 — 需要真实模型请求的系统提示词'],
  ['只读档下模型被告知限制', '9.4 — 需要真实模型请求的系统提示词'],
  ['切换档位后播报更新', '9.4 — 需要连续两次真实模型请求'],
  ['降级后切换请求明确失败', '9.6 — 需要对无档位能力的部署'],
  ['呈现会话当前档位', '9.4 — 需要真实会话与会话历史投影'],
  ['切换成功即生效', '9.4 — 需要端到端切换'],
  ['切换失败保持原状', '9.4 — 需要一次真实失败'],
  ['未确认不切换', '9.4 — 需要面板确认门交互'],
  ['每次都需要确认', '9.4 — 需要面板确认门交互'],
  ['确认文案覆盖两侧权限', '9.4 — 需要面板确认门交互'],
  ['dsh 界面改档位同步到面板', '6.7 — 需要 dsh Web 界面与面板并排观察'],
  ['面板改档位同步到 dsh 界面', '6.7 — 需要 dsh Web 界面与面板并排观察'],
  ['面板外改动覆盖乐观更新', '9.4 — 需要真实投影回流'],
  ['关闭状态下的读取被拒', '7.4 — 需要真实工具调用'],
  ['每次询问状态下的读取需确认', '7.4 — 需要真实工具调用'],
  ['分享关闭的提示指向真实入口', '7.4 — 需要真实工具调用返回文案'],
  ['改档位不影响分享', '7.4 — 需要两条轴的交叉观察'],
  ['只读档下读取仍由分享决定', '7.4 — 需要真实工具调用'],
  // panel-remote-host-config (modified)
  ['配置不外泄', '既有行为，本次未改动该路径'],
  // bridge-tier-source-of-truth — the fold is asserted offline; these need a live
  // session because they are about what the BRIDGE does with the verdict.
  // The two sources are distinguishable in the code, but only a run against a
  // real registry that throws can show the distinct records actually land.
  ['读取抛错与数据缺失可区分', '7.4 — 需要一次真实的投影读取抛错'],
  ['降级后工具照常可用', '7.5 — 需要真实工具调用（无档位部署）'],
  ['降级后切换请求明确失败', '7.5 — 需要无档位能力的真实部署'],
  ['能力存在时求解失败不等于降级', '7.4 — 需要构造一次真实求解失败并观察下一次调用'],
  ['放宽连接目标不削弱审批', '9.4 — 需要远端连接下的真实审批'],
  ['远端连接不改变档位判定来源', '9.4 — 需要远端连接下的真实调用'],
])

// Both the tier-capability delta and this change's own delta are scanned: the
// second deliberately SUPERSEDES parts of the first, so a scenario that only
// the older spec still states must not be able to hide behind a green run.
const SPEC_ROOTS = [
  'openspec/changes/panel-permission-tiers/specs',
  'openspec/changes/bridge-tier-source-of-truth/specs',
]
const scenarioNames = []
for (const root of SPEC_ROOTS) {
  const specDir = join(repoRoot, root)
  if (!existsSync(specDir)) continue
  for (const capability of readdirSync(specDir)) {
    const file = join(specDir, capability, 'spec.md')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^#### Scenario: (.+)$/.exec(line.trim())
      if (match !== null) scenarioNames.push({ root, capability, name: match[1].trim() })
    }
  }
}
const unclassified = scenarioNames.filter(
  (s) => !DECIDED_HERE.has(s.name) && !DEFERRED_TO_LIVE.has(s.name))
check(
  `全部 ${scenarioNames.length} 条 spec 场景都已分类（此处判定或明确留给实测）`,
  unclassified.length === 0,
  `unclassified: ${unclassified.map((s) => `${s.capability}/${s.name}`).join(', ')}`,
)

// ---------------------------------------------------------------------------
const total = failures === 0
console.log(total ? '\nall permission-tier checks passed' : `\n${failures} check(s) FAILED`)
console.log(`spec 场景：${scenarioNames.length} 条 — 本脚本判定 ${DECIDED_HERE.size} 条，留待实测 ${DEFERRED_TO_LIVE.size} 条`)
process.exit(total ? 0 : 1)
