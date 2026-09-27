#!/usr/bin/env node
/**
 * Behavioral check for page-context injection timing.
 *
 * The repo has no test suite, so this bundles the REAL `page-context.ts` with
 * the same esbuild resolution order as the package build scripts and asserts
 * every decidable scenario in `openspec/changes/page-context-first-message/specs/`.
 *
 * The module under test is deliberately DOM-free, so no browser or running dsh
 * is needed: the text/skill first-message gate and the region always-inject
 * rule are pure functions of (gate, sessionId, page, content).
 *
 * Usage: pnpm check:page-context   (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'page-context-injection')

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

mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'page-context.mjs')
const result = spawnSync(resolveEsbuild(), [
  join(repoRoot, 'packages/extension/src/panel/page-context.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${outfile}`,
  `--alias:@dsh-browser/protocol=${join(repoRoot, 'packages/protocol/src/index.ts')}`,
  '--log-level=error',
], { cwd: repoRoot, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

const { pageContextBlock, withTextPageContext, withRegionPageContext } = await import(pathToFileURL(outfile).href)

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

const PAGE = { url: 'https://example.com/foo', title: '示例页' }
const isPageBlock = (block) => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[网页描述]')
const textOf = (block) => (typeof block === 'object' && block !== null && typeof block.text === 'string' ? block.text : '')

// ---------------------------------------------------------------------------
// pageContextBlock: builds the [网页描述] text block from title/url.
// ---------------------------------------------------------------------------
check(
  'pageContextBlock 产出 [网页描述] 文本块',
  isPageBlock(pageContextBlock(PAGE)) && textOf(pageContextBlock(PAGE)).includes('https://example.com/foo'),
  `unexpected block: ${JSON.stringify(pageContextBlock(PAGE))}`,
)

// ---------------------------------------------------------------------------
// Requirement 1: 文本/技能首条注入, 后续不注入, 会话隔离, 技能同门控.
// ---------------------------------------------------------------------------

// 首条文本注入并置位, 用户消息保留在第二位.
{
  const gate = new Set()
  const out = withTextPageContext(gate, 'S', PAGE, [{ type: 'text', text: '你好' }])
  check('首条文本注入网页描述', out.length === 2 && isPageBlock(out[0]), `out=${JSON.stringify(out)}`)
  check('首条文本置位 gate', gate.has('S'), 'gate 未置位')
  check('首条文本保留用户消息', textOf(out[1]) === '你好', `out[1]=${textOf(out[1])}`)
}

// 同会话后续文本不再注入.
{
  const gate = new Set(['S'])
  const out = withTextPageContext(gate, 'S', PAGE, [{ type: 'text', text: '再来一条' }])
  check('同会话后续文本不注入', out.length === 1 && textOf(out[0]) === '再来一条', `out=${JSON.stringify(out)}`)
}

// 会话粒度隔离.
{
  const gate = new Set(['S1'])
  const s2 = withTextPageContext(gate, 'S2', PAGE, [{ type: 'text', text: 'x' }])
  const s1 = withTextPageContext(gate, 'S1', PAGE, [{ type: 'text', text: 'y' }])
  check('会话隔离: 新会话 S2 注入', s2.length === 2 && isPageBlock(s2[0]), `s2=${JSON.stringify(s2)}`)
  check('会话隔离: 已注入 S1 不再注入', s1.length === 1, `s1=${JSON.stringify(s1)}`)
}

// 技能与文本共用同一条 sendText 门控: 已置位的会话, 技能手势不注入.
{
  const gate = new Set(['S'])
  const out = withTextPageContext(gate, 'S', PAGE, [{ type: 'text', text: '/some-skill' }])
  check('技能共享首条门控: 已置位不注入', out.length === 1 && textOf(out[0]) === '/some-skill', `out=${JSON.stringify(out)}`)
}

// ---------------------------------------------------------------------------
// Requirement 2: 区域截图每轮注入, 且区域先行后文本不再注入.
// ---------------------------------------------------------------------------

// 区域始终注入(即使 gate 已置位), 且保持在最前.
{
  const gate = new Set(['S'])
  const image = { type: 'image', mediaType: 'image/png', data: 'x', name: 'region.jpeg' }
  const out = withRegionPageContext(gate, 'S', PAGE, [image])
  check('区域截图始终注入网页描述', out.length === 2 && isPageBlock(out[0]), `out=${JSON.stringify(out)}`)
  check('区域截图保持原内容', out[1] === image, 'image block 被篡改')
}

// 区域先行后文本不再注入(区域已把 gate 置位).
{
  const gate = new Set()
  withRegionPageContext(gate, 'S', PAGE, [])
  const out = withTextPageContext(gate, 'S', PAGE, [{ type: 'text', text: 'q' }])
  check('区域先行后文本不注入', out.length === 1 && textOf(out[0]) === 'q', `out=${JSON.stringify(out)}`)
}

// ---------------------------------------------------------------------------
// page 为空时不注入且不置位(下次有页面时仍可注入).
// ---------------------------------------------------------------------------
{
  const gate = new Set()
  const textOut = withTextPageContext(gate, 'S', null, [{ type: 'text', text: 'hi' }])
  const regionOut = withRegionPageContext(gate, 'S', null, [])
  check('page 为空: 文本不注入', textOut.length === 1, `textOut=${JSON.stringify(textOut)}`)
  check('page 为空: 区域不注入', regionOut.length === 0, `regionOut=${JSON.stringify(regionOut)}`)
  check('page 为空: gate 不置位', !gate.has('S'), 'gate 被错误置位')
}

console.log(failures === 0 ? '\nall page-context-injection checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
