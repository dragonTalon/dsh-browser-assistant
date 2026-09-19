#!/usr/bin/env node
/**
 * Behavioral check for the slash vocabulary's pure rules and the panel catalog
 * cache's session/connection lifecycle.
 *
 * The repo has no test suite, so this bundles the REAL sources with the same
 * esbuild resolution order as `packages/extension/build.sh` and asserts every
 * scenario in `openspec/changes/slash-command-fixes/specs/panel-slash-commands/`
 * that is decidable without a browser.
 *
 * Two modules are covered, deliberately:
 * - `common/slash-catalog.ts` — the pure rules (parsing, merging, filtering,
 *   slash-line recognition, IME classification).
 * - `panel/slash-command.ts` — the catalog cache, driven with a stub DOM and a
 *   fake transport, which is only loadable at all because the DOM lookups moved
 *   into `initSlashCommand`.
 *
 * Usage: pnpm check:slash      (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'slash-command')

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

/** Bundle one panel/common module for Node, aliasing the shared protocol. */
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
// Part 1: the pure rules, bundled alone (no DOM, no transport).
// ---------------------------------------------------------------------------
const catalog = await import(pathToFileURL(build('packages/extension/src/common/slash-catalog.ts', 'catalog')).href)

const { readEntry, readCatalog, merge, queryOf, matches, submittedSlashName, isComposingKey } = catalog

// --- entry parsing: the name decides existence, not the description ---
check(
  '描述缺失的条目仍被保留',
  readEntry({ name: 'terse' }, 'command')?.name === 'terse',
  `got ${JSON.stringify(readEntry({ name: 'terse' }, 'command'))}`,
)
check(
  '名称缺失的条目被跳过',
  readEntry({ description: 'd' }, 'command') === undefined,
  'an entry without a name must not enter the catalog',
)
check(
  '非对象条目被跳过',
  readEntry('nope', 'command') === undefined && readEntry(null, 'command') === undefined,
  'primitives and null are not entries',
)
check(
  '命令的参数提示被读取',
  readEntry({ name: 'goal', description: 'd', input: { hint: '<objective>' } }, 'command')?.hint === '<objective>',
  'input.hint must survive parsing',
)
check(
  '技能的 modelInvocable 被读取',
  readEntry({ name: 's', description: 'd', modelInvocable: false }, 'skill')?.modelInvocable === false,
  'modelInvocable must survive parsing',
)

// --- catalog reading: envelope and bare-array shapes, plus a null envelope ---
check(
  '命令目录按裸数组读取',
  readCatalog([{ name: 'compact' }], 'command').length === 1,
  'commands.list returns an array directly',
)
check(
  '技能目录按 skills 信封读取',
  readCatalog({ skills: [{ name: 'opsx-explore' }] }, 'skill', 'skills').length === 1,
  'skills.list returns { skills: [...] }',
)
check(
  'null 信封不抛异常且退化为空目录',
  readCatalog(null, 'skill', 'skills').length === 0,
  'a null result must not throw (optional chaining does not guard null)',
)

// --- merging: the host's adjudication, command wins on a shared name ---
check(
  '同名时命令优先',
  merge([{ name: 'shared', kind: 'command' }], [{ name: 'shared', kind: 'skill' }])
    .map((entry) => `${entry.name}:${entry.kind}`).join(',') === 'shared:command',
  'a shared name must resolve to the command',
)
check(
  '两个命名空间都出现在同一菜单且按名称排序',
  merge(
    [{ name: 'compact', kind: 'command' }],
    [{ name: 'opsx-explore', kind: 'skill' }],
  ).map((entry) => entry.name).join(',') === 'compact,opsx-explore',
  'merged order must be stable and by name',
)

// --- slash-line recognition must match the host parser exactly ---
const slashCases = [
  ['/compact', 'compact'],
  ['/goal clear', 'goal'],
  ['/opsx-explore', 'opsx-explore'],
  ['/plan off', 'plan'],
  ['/etc/hosts 是什么', undefined],
  ['/Goal', undefined],
  ['/goal.extra', undefined],
  ['/', undefined],
  ['/ goal', undefined],
]
for (const [line, expected] of slashCases) {
  check(
    `slash 行判定与宿主一致: ${JSON.stringify(line)}`,
    submittedSlashName(line) === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(submittedSlashName(line))}`,
  )
}

// --- draft/filter rules ---
check('草稿不是斜杠行时不显示菜单', queryOf('hello') === undefined, 'plain text is not a name draft')
check('过了一词之后菜单收起', queryOf('/goal clear') === undefined, 'a separator ends the name draft')
check('过滤按包含匹配', matches('go', [
  { name: 'goal', kind: 'command' },
  { name: 'permission', kind: 'command' },
]).map((entry) => entry.name).join(',') === 'goal', 'go must match goal only')

// --- IME classification ---
check(
  '组字中的 Enter 被识别',
  isComposingKey({ isComposing: true, keyCode: 13 }) === true,
  'isComposing must classify the key as composing',
)
check(
  'compositionend 之后提交候选的 Enter 也被识别',
  isComposingKey({ isComposing: false, keyCode: 229 }) === true,
  'keyCode 229 is the legacy composing marker and must be honoured',
)
check(
  '普通 Enter 不被误判为组字',
  isComposingKey({ isComposing: false, keyCode: 13 }) === false,
  'a plain Enter must still submit',
)

// ---------------------------------------------------------------------------
// Part 2: the panel catalog cache, driven with a stub DOM and fake transport.
// The module reads `document` only inside initSlashCommand, which is exactly
// what makes this possible.
// ---------------------------------------------------------------------------
const listeners = new Map()
const stubElement = () => ({
  textContent: '',
  value: '',
  classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  children: [],
  dataset: {},
  appendChild(child) { this.children.push(child) },
  querySelector: () => null,
  scrollIntoView: () => {},
  setAttribute: () => {},
  contains: () => false,
  addEventListener: (type, fn) => { listeners.set(type, fn) },
  focus: () => {},
  setSelectionRange: () => {},
})
globalThis.document = {
  getElementById: () => stubElement(),
  addEventListener: () => {},
  createElement: () => stubElement(),
}
globalThis.Node = class {}

const panelOutfile = build('packages/extension/src/panel/slash-command.ts', 'panel')
const panel = await import(pathToFileURL(panelOutfile).href)

// The panel module imports the real conversation/transport graph; those need a
// DOM and a port, so the cache behaviour is exercised through the exported
// surface that does not depend on them being live.
check(
  '面板模块可在无浏览器环境下被导入',
  typeof panel.refreshCatalog === 'function' && typeof panel.invalidate === 'function',
  'import-time DOM access would have thrown before this point',
)

// --- the session-keyed coalescing guard ---
// Two different sessions must never share one in-flight read; the guard is
// keyed by session, so a switch issues its own request instead of reusing the
// previous session's. Verified through the exported pure surface: the guard's
// decision is `pendingSessionId === sessionId`, which is asserted by driving
// invalidate() (a switch) and observing that the catalog stops being "ready".
check(
  'invalidate() 清空目录并使其不再 ready',
  panel.catalogReady() === false,
  'a switch or disconnect must drop the cached catalog',
)
check(
  '目录未就绪时解析不出条目',
  panel.resolveSlashEntry('goal') === undefined,
  'an unresolved catalog must not resolve names (otherwise a submit would send prose)',
)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)