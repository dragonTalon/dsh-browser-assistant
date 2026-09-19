#!/usr/bin/env node
/**
 * Drift guard for the shared browser-tool registry.
 *
 * The tool names and their semantic classifications (action class, page-delta
 * attachment, navigation candidacy) live in exactly one place —
 * `packages/protocol/src/browser-tools.ts` — and every consumer must derive
 * from it. This check bundles the REAL sources with the same esbuild
 * resolution order as the package build scripts and asserts:
 *
 * 1. the registry itself pins the pre-registry classification tables;
 * 2. the bridge tier gate (permission.ts) classifies exactly like the registry;
 * 3. the extension approval judgement (authorization.ts) and the navigation
 *    flag (background/tools.ts) derive exactly like the registry;
 * 4. the bridge tool definitions register exactly the registry's name set, and
 *    each tool's execute dispatches exactly its own wire name;
 * 5. the `unknown-tool` refusal fires BEFORE any frame when a tool definition
 *    exists but its registry entry is missing (simulated by re-bundling with a
 *    protocol shim that drops one descriptor) — zero dispatches reach the
 *    extension;
 * 6. no local classification table literals may re-emerge in the source files
 *    that used to carry them, and the content-script dispatch table covers
 *    exactly the registry's name set.
 *
 * Usage: pnpm check:tool-registry   (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'tool-registry')
const protocolIndex = join(repoRoot, 'packages/protocol/src/index.ts')

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

/** Bundle one module for Node, aliasing the shared protocol (and any stubs). */
function build(relativePath, name, extraAliases = []) {
  const outfile = join(outDir, `${name}.mjs`)
  const args = [
    join(repoRoot, relativePath),
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    `--outfile=${outfile}`,
    '--external:ws',
    `--alias:@dsh-browser/protocol=${protocolIndex}`,
    ...HOST_ALIASES,
    ...extraAliases,
    '--log-level=error',
  ]
  const result = spawnSync(resolveEsbuild(), args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return outfile
}

mkdirSync(outDir, { recursive: true })

// The bridge is a dsh plugin, so its sources import `@deepseek-ai/*` packages
// that exist only inside a dsh installation. These checks bundle the REAL
// sources and must run on a checkout without dsh, so every host import
// reachable from the bundled entry points is aliased to a stub — resolution
// must never depend on a machine's dsh profile. `tools.ts` reaches
// `@deepseek-ai/dsh-home-paths` through `server.ts` → `token.ts`, and
// `defineTool` from `@deepseek-ai/dsh-tools` is the registration entry point.
const dshToolsStub = join(outDir, 'stub-dsh-tools.mjs')
writeFileSync(dshToolsStub, 'export function defineTool(definition) { return definition }\n')
const dshHomePathsStub = join(outDir, 'stub-dsh-home-paths.mjs')
writeFileSync(dshHomePathsStub, 'export function dshHomePath(...parts) { return parts.join("/") }\n')
const HOST_ALIASES = [
  `--alias:@deepseek-ai/dsh-tools=${dshToolsStub}`,
  `--alias:@deepseek-ai/dsh-home-paths=${dshHomePathsStub}`,
]

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

function setEquals(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value))
}

// ---------------------------------------------------------------------------
// Part 1: the registry pins the historical classification tables.
// ---------------------------------------------------------------------------
const registry = await import(pathToFileURL(build('packages/protocol/src/browser-tools.ts', 'registry')).href)
const {
  BROWSER_TOOL_DESCRIPTORS,
  BROWSER_TOOL_NAMES,
  actionClassOf,
  isPageReadTool,
  isStateChangingTool,
  attachesPageDelta,
  isNavigationCandidate,
} = registry

const CLASS_EXPECTED = {
  read: ['browser_snapshot', 'browser_get_text'],
  observe: ['browser_scroll', 'browser_wait'],
  mutate: ['browser_click', 'browser_type', 'browser_press'],
  navigate: ['browser_navigate', 'browser_open_tab', 'browser_back', 'browser_forward', 'browser_reload'],
}
const DELTA_EXPECTED = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait'])
const NAV_EXPECTED = new Set(['browser_click', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_open_tab'])

const allNames = new Set(BROWSER_TOOL_NAMES)
check('注册表恰好 12 个工具且名集与历史四类一致',
  BROWSER_TOOL_DESCRIPTORS.length === 12
  && setEquals(allNames, new Set([...CLASS_EXPECTED.read, ...CLASS_EXPECTED.observe, ...CLASS_EXPECTED.mutate, ...CLASS_EXPECTED.navigate])),
  JSON.stringify(BROWSER_TOOL_NAMES))

for (const [actionClass, names] of Object.entries(CLASS_EXPECTED)) {
  check(`${actionClass} 分类一致`,
    names.every((name) => actionClassOf(name) === actionClass),
    names.filter((name) => actionClassOf(name) !== actionClass).join(','))
}
check('isPageReadTool 与 read 类一致', allNames && [...allNames].every((name) => isPageReadTool(name) === CLASS_EXPECTED.read.includes(name)))
check('isStateChangingTool 与 mutate/navigate 类一致',
  [...allNames].every((name) => isStateChangingTool(name) === (CLASS_EXPECTED.mutate.includes(name) || CLASS_EXPECTED.navigate.includes(name))))
check('attachesPageDelta 与历史 delta 表一致', [...allNames].every((name) => attachesPageDelta(name) === DELTA_EXPECTED.has(name)))
check('isNavigationCandidate 与历史导航表一致', [...allNames].every((name) => isNavigationCandidate(name) === NAV_EXPECTED.has(name)))

const unknownNames = ['browser_upload', 'browser_screenshot', 'browser_hover', '']
check('未注册名分类为 undefined(不可猜测)',
  unknownNames.every((name) => actionClassOf(name) === undefined && !isPageReadTool(name) && !isStateChangingTool(name)),
  unknownNames.filter((name) => actionClassOf(name) !== undefined).join(','))

// ---------------------------------------------------------------------------
// Part 2: consumers derive exactly like the registry.
// ---------------------------------------------------------------------------
const permission = await import(pathToFileURL(build('packages/bridge-dsh/src/permission.ts', 'permission')).href)
check('bridge 档位闸门 actionClassOf === 注册表(全部名)',
  BROWSER_TOOL_NAMES.every((name) => permission.actionClassOf(name) === actionClassOf(name)))
check('bridge 档位闸门对未注册名返回 undefined',
  unknownNames.every((name) => permission.actionClassOf(name) === undefined))

const authorization = await import(pathToFileURL(build('packages/extension/src/background/authorization.ts', 'authorization')).href)
check('extension isPageRead === 注册表(全部名)',
  BROWSER_TOOL_NAMES.every((name) => authorization.isPageRead(name) === isPageReadTool(name)))
check('extension 审批判定 === isStateChangingTool(全部名)',
  BROWSER_TOOL_NAMES.every((name) => {
    const prompt = authorization.approvalPromptForCall({ id: 'x', name, args: {} }, 'auto', [], 'en')
    return (prompt !== undefined) === isStateChangingTool(name)
  }))

const bgTools = await import(pathToFileURL(build('packages/extension/src/background/tools.ts', 'bg-tools')).href)
check('extension isNavigationCandidateTool === 注册表(全部名)',
  BROWSER_TOOL_NAMES.every((name) => bgTools.isNavigationCandidateTool(name) === isNavigationCandidate(name)))

// ---------------------------------------------------------------------------
// Part 3: bridge tool definitions match the registry, and the unknown-tool
// refusal fires before any frame.
// ---------------------------------------------------------------------------
async function registerTools(module) {
  const registered = []
  const dispatched = []
  const ctx = { tools: { register(definition) { registered.push(definition); return () => {} } } }
  const bridge = {
    requestTool: async (name) => {
      dispatched.push(name)
      return { text: 'ok' }
    },
  }
  module.registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60 })
  return { registered, dispatched }
}

const exec = { agent: undefined, signal: new AbortController().signal }

const realTools = await import(pathToFileURL(build('packages/bridge-dsh/src/tools.ts', 'bridge-tools')).href)
const real = await registerTools(realTools)
check('bridge 注册的工具名集合 === 注册表名集合',
  setEquals(new Set(real.registered.map((definition) => definition.name)), allNames),
  `registered=${real.registered.map((definition) => definition.name).join(',')}`)
for (const definition of real.registered) {
  const result = await definition.execute({}, exec)
  check(`execute ${definition.name} 返回文本`, result !== null && typeof result === 'object' && typeof result.text === 'string')
}
check('每个工具恰分发自己的线名(无重名、无串线)',
  real.dispatched.length === real.registered.length
  && real.registered.every((definition, index) => real.dispatched[index] === definition.name),
  real.dispatched.join(','))

// Re-bundle with a protocol shim whose registry lost `browser_click` — the
// exact drift the registry exists to catch. The tool DEFINITION still exists,
// but its registration is gone, so the gate must refuse it as unknown-tool
// before a single frame is written.
const protocolShim = join(outDir, 'protocol-minus-click.mjs')
writeFileSync(protocolShim, [
  `import { BROWSER_TOOL_DESCRIPTORS as ALL_DESCRIPTORS } from ${JSON.stringify(protocolIndex)}`,
  `export * from ${JSON.stringify(protocolIndex)}`,
  'const DESCRIPTORS = ALL_DESCRIPTORS.filter((descriptor) => descriptor.name !== \'browser_click\')',
  'export const BROWSER_TOOL_DESCRIPTORS = DESCRIPTORS',
  'export const BROWSER_TOOL_NAMES = DESCRIPTORS.map((descriptor) => descriptor.name)',
  'const BY_NAME = new Map(DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]))',
  'export function actionClassOf(name) { return BY_NAME.get(name)?.actionClass }',
  'export function isPageReadTool(name) { return actionClassOf(name) === \'read\' }',
  'export function isStateChangingTool(name) { const cls = actionClassOf(name); return cls === \'mutate\' || cls === \'navigate\' }',
  'export function attachesPageDelta(name) { return BY_NAME.get(name)?.attachesDelta === true }',
  'export function isNavigationCandidate(name) { return BY_NAME.get(name)?.navigationCandidate === true }',
].join('\n'))

const driftTools = await import(pathToFileURL(build('packages/bridge-dsh/src/tools.ts', 'bridge-tools-drift', [
  `--alias:@dsh-browser/protocol=${protocolShim}`,
])).href)
const drift = await registerTools(driftTools)
check('漂移构建仍注册 12 个工具定义(定义与注册表分属两层)',
  drift.registered.length === 12,
  `registered=${drift.registered.length}`)
const dropped = drift.registered.find((definition) => definition.name === 'browser_click')
let driftError
try {
  await dropped.execute({}, exec)
} catch (error) {
  driftError = error
}
check('缺失注册表条目的工具以 unknown-tool 拒绝',
  driftError !== undefined && driftError.code === 'unknown-tool',
  driftError === undefined ? 'no error thrown' : `code=${String(driftError.code)}`)
check('拒绝发生在任何帧之前(零分发)',
  drift.dispatched.length === 0,
  `dispatched=${drift.dispatched.join(',')}`)
for (const definition of drift.registered) {
  if (definition.name === 'browser_click') continue
  await definition.execute({}, exec)
}
check('其余 11 个工具不受漂移影响',
  drift.dispatched.length === 11
  && drift.dispatched.every((name, index) => drift.registered.filter((definition) => definition.name !== 'browser_click')[index].name === name),
  drift.dispatched.join(','))

// ---------------------------------------------------------------------------
// Part 4: no local classification tables may re-emerge; the content dispatch
// table covers exactly the registry's names.
// ---------------------------------------------------------------------------
const FORBIDDEN_TABLES = [
  'READ_TOOLS', 'OBSERVE_TOOLS', 'MUTATE_TOOLS', 'NAVIGATE_TOOLS',
  'PAGE_READS', 'STATE_CHANGING_ACTIONS',
  'ACTION_DELTA_TOOLS', 'NAVIGATION_CANDIDATE_TOOLS',
]
const guardedSources = [
  'packages/bridge-dsh/src/permission.ts',
  'packages/extension/src/background/authorization.ts',
  'packages/extension/src/background/tools.ts',
]
for (const relativePath of guardedSources) {
  const text = readFileSync(join(repoRoot, relativePath), 'utf8')
  const revived = FORBIDDEN_TABLES.filter((name) => text.includes(name))
  check(`${relativePath} 不再含本地分类表字面量`, revived.length === 0, `发现: ${revived.join(',')}`)
}

const actionsSource = readFileSync(join(repoRoot, 'packages/extension/src/content/actions.ts'), 'utf8')
const dispatchKeys = new Set([...actionsSource.matchAll(/^\s{2}(browser_\w+):/gm)].map((match) => match[1]))
// `browser_open_tab` is the one registered action the background handles
// itself (chrome.tabs.create) and therefore never dispatches to content; the
// dispatch table must cover every other registered name and implement nothing
// unregistered.
const backgroundHandled = new Set(['browser_open_tab'])
const missingImplementations = [...allNames].filter((name) => !dispatchKeys.has(name) && !backgroundHandled.has(name))
const orphanImplementations = [...dispatchKeys].filter((name) => !allNames.has(name))
check('content 分发表覆盖全部注册名(除 background 自理的 open_tab)',
  missingImplementations.length === 0 && orphanImplementations.length === 0,
  `missing=${missingImplementations.join(',')} orphan=${orphanImplementations.join(',')}`)

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\ntool-registry checks failed: ${failures}`)
  process.exit(1)
}
console.log('\nall tool-registry checks passed')
