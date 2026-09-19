#!/usr/bin/env node
/**
 * Behavioral check for the panel session picker's pure logic.
 *
 * The repo has no test suite, so this bundles the REAL source with the same
 * esbuild resolution order as `packages/extension/build.sh` and asserts every
 * scenario in `openspec/specs/panel-session-selection/spec.md` that is
 * decidable without a browser: which sessions are offered, how rows are
 * labelled, how many are rendered, and how live frames are joined to a
 * history replay.
 *
 * Usage: pnpm check:selection        (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'session-selection')

/** Mirror build.sh's esbuild resolution: override → workspace → offline fallback. */
function resolveEsbuild() {
  const candidates = [
    process.env.ESBUILD,
    join(repoRoot, 'packages/extension/node_modules/.bin/esbuild'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('error: esbuild not found (run pnpm install, or set ESBUILD)')
    process.exit(1)
  }
  return found
}

/** Bundle one DOM-free source module and import it. */
async function loadModule(relativePath) {
  const outfile = join(outDir, `${relativePath.split('/').pop().replace(/\.ts$/u, '')}.mjs`)
  const built = spawnSync(resolveEsbuild(), [
    join(repoRoot, relativePath),
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    `--outfile=${outfile}`,
    '--log-level=error',
  ], { stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
  return await import(pathToFileURL(outfile).href)
}

mkdirSync(outDir, { recursive: true })
const { buildSessionOptions, formatSessionOption, SESSION_OPTION_LIMIT } =
  await loadModule('packages/extension/src/common/session-list.ts')
const { bufferEvent, eventSeq, selectEventsAfterReplay, MAX_BUFFERED_EVENTS } =
  await loadModule('packages/extension/src/common/session-events.ts')

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const minutes = (count) => count * 60_000
const hours = (count) => count * 3_600_000

/** One `session.list` item, valid unless overridden. */
function entry(overrides = {}) {
  return {
    sessionId: 'session-1234abcd-0000-4000-8000-000000000000',
    updatedAt: NOW - minutes(5),
    running: false,
    blank: false,
    cwd: '/Users/dev/proj',
    projections: { asOfSeq: 10, values: { title: '一个会话' } },
    ...overrides,
  }
}

// --- 候选过滤 ---------------------------------------------------------------
{
  const result = buildSessionOptions([
    entry({ sessionId: 'session-blank', blank: true }),
    entry({ sessionId: 'session-sub', origin: 'subagent' }),
    entry({ sessionId: 'session-real', projections: { values: { title: '真实会话' } } }),
  ], NOW)
  check(
    '空会话与子代理会话不进候选',
    result.options.length === 1 && result.options[0].id === 'session-real' && result.total === 1,
    JSON.stringify(result),
  )
}

{
  const result = buildSessionOptions([
    null,
    'nope',
    {},
    entry({ sessionId: '' }),
    entry({ sessionId: 'session-ok' }),
  ], NOW)
  check(
    '非法条目被跳过而不抛错',
    result.options.length === 1 && result.options[0].id === 'session-ok',
    JSON.stringify(result),
  )
}

{
  const result = buildSessionOptions('not-an-array', NOW)
  check('响应形状异常时返回空候选', result.options.length === 0 && result.truncated === false, JSON.stringify(result))
}

// --- 排序与截断 -------------------------------------------------------------
{
  const result = buildSessionOptions([
    entry({ sessionId: 'session-old', updatedAt: NOW - hours(2) }),
    entry({ sessionId: 'session-new', updatedAt: NOW - minutes(1) }),
    entry({ sessionId: 'session-mid', updatedAt: NOW - minutes(10) }),
  ], NOW)
  check(
    '候选按最近活动倒序',
    result.options.map((option) => option.id).join(',') === 'session-new,session-mid,session-old',
    JSON.stringify(result.options.map((option) => option.id)),
  )
}

{
  const many = Array.from({ length: 58 }, (_unused, index) => entry({
    sessionId: `session-${index}`,
    updatedAt: NOW - minutes(index),
  }))
  const result = buildSessionOptions(many, NOW)
  check(
    '58 条候选截断为 50 且带截断标记',
    result.options.length === SESSION_OPTION_LIMIT && result.options.length === 50
      && result.total === 58 && result.truncated === true,
    JSON.stringify({ shown: result.options.length, total: result.total, truncated: result.truncated }),
  )
  check(
    '截断保留最近活动的条目',
    result.options[0].id === 'session-0' && result.options[49].id === 'session-49',
    JSON.stringify([result.options[0].id, result.options[49].id]),
  )
}

// --- 标题与副标签 -----------------------------------------------------------
{
  const result = buildSessionOptions([
    entry({ sessionId: 'session-abcdefgh-1111', projections: undefined }),
    entry({ sessionId: 'session-ijklmnop-2222', projections: { values: { title: null } } }),
    entry({ sessionId: 'session-qrstuvwx-3333', projections: { values: { title: '   ' } } }),
  ], NOW)
  check(
    '标题缺失回退会话标识前 8 位',
    result.options.every((option) => option.label === `${option.id.slice(0, 8)}…`)
      && result.options[0].label === 'session-…',
    JSON.stringify(result.options.map((option) => option.label)),
  )
}

{
  const result = buildSessionOptions([
    entry({ projections: { values: { title: '换行\n标题   带空格' } } }),
  ], NOW)
  check('标题空白被折叠为单行', result.options[0].label === '换行 标题 带空格', JSON.stringify(result.options[0].label))
}

{
  const option = (overrides) => buildSessionOptions([entry(overrides)], NOW).options[0]
  const text = (overrides) => formatSessionOption(option(overrides))
  const fiveMin = NOW - minutes(5)
  check('工作区前缀排在最前', text({ updatedAt: fiveMin, projections: { values: { title: '修一个 bug' } } })
    === '[proj] 修一个 bug · 5 分钟前', text({ updatedAt: fiveMin, projections: { values: { title: '修一个 bug' } } }))
  check('30 秒前显示「刚刚」', text({ updatedAt: NOW - 30_000 }) === '[proj] 一个会话 · 刚刚', text({ updatedAt: NOW - 30_000 }))
  check('5 分钟前显示分钟', text({ updatedAt: fiveMin }) === '[proj] 一个会话 · 5 分钟前', text({ updatedAt: fiveMin }))
  check('3 小时前显示小时', text({ updatedAt: NOW - hours(3) }) === '[proj] 一个会话 · 3 小时前', text({ updatedAt: NOW - hours(3) }))
  check('2 天前显示天', text({ updatedAt: NOW - hours(48) }) === '[proj] 一个会话 · 2 天前', text({ updatedAt: NOW - hours(48) }))
  check('超过 30 天显示日期', /^\[proj\] 一个会话 · \d{4}-\d{2}-\d{2}$/u.test(text({ updatedAt: NOW - hours(24 * 60) })), text({ updatedAt: NOW - hours(24 * 60) }))
  check('未来时间不产生负数', text({ updatedAt: NOW + minutes(5) }) === '[proj] 一个会话 · 刚刚', text({ updatedAt: NOW + minutes(5) }))
  check('cwd 尾部分隔符被忽略', text({ updatedAt: fiveMin, cwd: '/Users/dev/proj/' }) === '[proj] 一个会话 · 5 分钟前', text({ updatedAt: fiveMin, cwd: '/Users/dev/proj/' }))
  check('cwd 缺失时省略方括号前缀', text({ updatedAt: fiveMin, cwd: undefined }) === '一个会话 · 5 分钟前', text({ updatedAt: fiveMin, cwd: undefined }))
  check('updatedAt 缺失时不带时间尾巴', text({ updatedAt: undefined }) === '[proj] 一个会话', text({ updatedAt: undefined }))
  check('运行中标记紧随工作区前缀', text({ running: true, updatedAt: fiveMin }) === '[proj] ● 一个会话 · 5 分钟前', text({ running: true, updatedAt: fiveMin }))
  check('工作区字段独立于标题', option({}).workspace === 'proj' && option({}).label === '一个会话', JSON.stringify(option({})))
}

{
  const result = buildSessionOptions([entry({ running: true })], NOW)
  check('运行中的会话带 running 标记位', result.options[0].running === true, JSON.stringify(result.options[0]))
}

// --- 重放与实时事件的相接 ---------------------------------------------------
{
  const frame = (seq) => ({ sessionId: 'session-S', seq, event: { type: 'turn/end', seq } })
  const handoff = selectEventsAfterReplay([frame(19), frame(21)], 20)
  check(
    '快照之后的实时帧被保留、快照内的不重复',
    handoff.apply.length === 1 && handoff.apply[0].seq === 21 && handoff.dropped === 0,
    JSON.stringify({ seqs: handoff.apply.map((item) => item.seq), dropped: handoff.dropped }),
  )
}

{
  const handoff = selectEventsAfterReplay([], 20)
  check('空缓冲不产生任何应用', handoff.apply.length === 0 && handoff.dropped === 0, JSON.stringify(handoff))
}

{
  const frame = (seq) => ({ sessionId: 'session-S', seq, event: { seq } })
  const handoff = selectEventsAfterReplay([frame(23), frame(21), frame(22)], 20)
  check(
    '应用顺序按序号升序',
    handoff.apply.map((item) => item.seq).join(',') === '21,22,23',
    JSON.stringify(handoff.apply.map((item) => item.seq)),
  )
}

{
  const bad = [
    { sessionId: 'session-S', seq: 'x', event: {} },
    { sessionId: 'session-S', seq: 1.5, event: {} },
    { sessionId: 'session-S', seq: -3, event: {} },
  ]
  const handoff = selectEventsAfterReplay([...bad, { sessionId: 'session-S', seq: 21, event: { seq: 21 } }], 20)
  check(
    '序号不可用的帧被丢弃且计数',
    handoff.apply.length === 1 && handoff.apply[0].seq === 21 && handoff.dropped === 3,
    JSON.stringify({ apply: handoff.apply.map((item) => item.seq), dropped: handoff.dropped }),
  )
}

{
  const frame = (seq) => ({ sessionId: 'session-S', seq, event: { seq } })
  const input = [frame(10), frame(22), frame(20), frame(21)]
  const handoff = selectEventsAfterReplay(input, 20)
  const seqs = handoff.apply.map((item) => item.seq)
  check(
    '混合缓冲结果唯一、严格递增且入参未被修改',
    seqs.join(',') === '21,22' && new Set(seqs).size === seqs.length && input.length === 4
      && input.map((item) => item.seq).join(',') === '10,22,20,21',
    JSON.stringify({ seqs, input: input.map((item) => item.seq) }),
  )
}

{
  const frame = (seq) => ({ sessionId: 'session-S', seq, event: { seq } })
  const handoff = selectEventsAfterReplay([frame(21), frame(21), frame(22)], 20)
  check(
    '重复序号只应用一次',
    handoff.apply.map((item) => item.seq).join(',') === '21,22' && handoff.dropped === 1,
    JSON.stringify({ seqs: handoff.apply.map((item) => item.seq), dropped: handoff.dropped }),
  )
}

{
  const frames = [1, 2, 3, 4, 5].map((seq) => ({ sessionId: 'session-S', seq, event: { seq } }))
  const handoff = selectEventsAfterReplay(frames, 0, 3)
  check(
    '缓冲超限丢弃最旧并计数',
    handoff.apply.map((item) => item.seq).join(',') === '3,4,5' && handoff.dropped === 2,
    JSON.stringify({ seqs: handoff.apply.map((item) => item.seq), dropped: handoff.dropped }),
  )
}

{
  const frame = (seq) => ({ sessionId: 'session-S', seq, event: { seq } })
  const handoff = selectEventsAfterReplay([frame(0), frame(7)], Number.NaN)
  check(
    '空历史（无边界）时全部应用',
    handoff.apply.map((item) => item.seq).join(',') === '0,7',
    JSON.stringify(handoff.apply.map((item) => item.seq)),
  )
}

{
  check('eventSeq 只接受非负安全整数',
    eventSeq({ seq: 0 }) === 0 && eventSeq({ seq: 1.5 }) === undefined
      && eventSeq({ seq: -1 }) === undefined && eventSeq({ seq: '3' }) === undefined
      && eventSeq(null) === undefined,
    JSON.stringify([eventSeq({ seq: 0 }), eventSeq({ seq: 1.5 }), eventSeq({ seq: -1 })]))
  check('bufferEvent 丢弃无序号事件',
    bufferEvent('session-S', { type: 'turn/end' }) === undefined
      && bufferEvent('session-S', { type: 'turn/end', seq: 7 })?.seq === 7,
    JSON.stringify(bufferEvent('session-S', { type: 'turn/end' })))
  check('缓冲上限为 500', MAX_BUFFERED_EVENTS === 500, String(MAX_BUFFERED_EVENTS))
}

rmSync(outDir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)