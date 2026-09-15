#!/usr/bin/env node
/**
 * Behavioral check for the `sessionWorkspace` grouping contract.
 *
 * The repo has no test suite, so this drives the REAL `RemoteHostApi` against a
 * fake TypertGateway and asserts every scenario in
 * `openspec/specs/bridge-session-workspace/spec.md` — including the branches
 * that are easy to get wrong (explicit location wins, failure never blocks
 * Session creation, failures are not cached, stale identity retried once).
 *
 * Usage: pnpm check:grouping        (no dsh and no network required)
 *
 * It bundles `packages/bridge-dsh/src/remote-host-api.ts` with the same
 * externals/alias as `packages/bridge-dsh/build.sh`, so it always tests the
 * current source rather than a stale `lib/` artifact.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'session-grouping')
const bundlePath = join(outDir, 'remote-host-api.mjs')

/** Mirror build.sh's esbuild resolution: override → workspace → offline fallback. */
function resolveEsbuild() {
  const candidates = [
    process.env.ESBUILD,
    join(repoRoot, 'packages/bridge-dsh/node_modules/.bin/esbuild'),
    '/Users/dragon/Documents/github/deepseek-harness/node_modules/.bin/esbuild',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('error: esbuild not found (run pnpm install, or set ESBUILD)')
    process.exit(1)
  }
  return found
}

mkdirSync(outDir, { recursive: true })
const built = spawnSync(resolveEsbuild(), [
  join(repoRoot, 'packages/bridge-dsh/src/remote-host-api.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${bundlePath}`,
  '--external:@deepseek-ai/*', '--external:ws',
  `--alias:@dsh-browser/protocol=${join(repoRoot, 'packages/protocol/src/index.ts')}`,
  '--log-level=error',
], { stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const { createRemoteHostApi } = await import(pathToFileURL(bundlePath).href)

const WS_PATH = '/repo/packages/bridge-dsh'
const WS_ID = 'ws-bridge-dsh'
const OK_CREATE = { workspace: { workspaceId: WS_ID, title: 'bridge-dsh' }, created: false }

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

const connection = { createSharedFetchHandler: () => ({ fetch: async () => new Response('') }) }
const signal = new AbortController().signal
const call = (method, payload) => ({ rpcId: 'rpc-1', method, payload, signal })

function makeGateway(overrides = {}) {
  const calls = []
  const {
    onCreate = () => OK_CREATE,
    onCreateSession = () => ({ sessionId: 'session-1' }),
    onPrompt = () => ({ accepted: true }),
  } = overrides
  return {
    calls,
    gateway: {
      wireStream: {
        open: async () => { throw new Error('wireStream.open is unused here') },
        failure: (e) => ({ code: 'internal', message: String(e), details: {} }),
      },
      async invoke(request) {
        calls.push(request)
        const { namespace, method } = request
        if (namespace === 'workspace' && method === 'create') return onCreate(request)
        if (namespace === 'session' && method === 'create') return onCreateSession(request)
        if (namespace === 'session' && method === 'prompt') return onPrompt(request)
        throw new Error(`unexpected invoke ${namespace}.${method}`)
      },
    },
  }
}

const sessionCreates = (calls) => calls.filter((c) => c.namespace === 'session' && c.method === 'create')
const workspaceCreates = (calls) => calls.filter((c) => c.namespace === 'workspace' && c.method === 'create')
const hasWorkspaceId = (request) => Object.hasOwn(request, 'workspaceId')
const coded = (code, message) => Object.assign(new Error(message), { code })

// --- spec: 未配置时不改变既有行为 -------------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection)
  const result = await api.call(call('session.create', {}))
  const sc = sessionCreates(calls)
  check(
    '未配置: 零 workspace.create,转发一次且不含 workspaceId',
    workspaceCreates(calls).length === 0 && sc.length === 1 && !hasWorkspaceId(sc[0].args.request),
    JSON.stringify(calls.map((c) => `${c.namespace}.${c.method}`)),
  )
  check('未配置: 会话创建成功', result.ok === true && result.value.sessionId === 'session-1', JSON.stringify(result))
}

// --- spec: 配置目录尚未注册时创建首个会话 ------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  const result = await api.call(call('session.create', {}))
  const wc = workspaceCreates(calls)
  const sc = sessionCreates(calls)
  check(
    '首个会话: 先以配置路径注册工作区',
    wc.length === 1 && wc[0].args.request.path === WS_PATH,
    JSON.stringify(wc.map((c) => c.args)),
  )
  check(
    '首个会话: 注入解析出的 workspaceId',
    sc.length === 1 && sc[0].args.request.workspaceId === WS_ID && result.ok === true,
    JSON.stringify(sc.map((c) => c.args)),
  )
  check('首个会话: 原始 payload 未被就地修改', !hasWorkspaceId({}), 'payload mutated')
}

// --- spec: 工作区已注册时复用既有身份 ---------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  await api.call(call('session.create', {}))
  await api.call(call('session.create', {}))
  check(
    '第二个会话: 不重复注册,复用缓存的 id',
    workspaceCreates(calls).length === 1 &&
      sessionCreates(calls).length === 2 &&
      sessionCreates(calls)[1].args.request.workspaceId === WS_ID,
    JSON.stringify(calls.map((c) => c.args)),
  )
}

// --- spec: 请求自带 workspaceId ---------------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  await api.call(call('session.create', { workspaceId: 'W2' }))
  check(
    '显式 workspaceId: 不注册、不被覆盖',
    workspaceCreates(calls).length === 0 && sessionCreates(calls)[0].args.request.workspaceId === 'W2',
    JSON.stringify(calls.map((c) => c.args)),
  )
}

// --- spec: 请求自带 cwd -----------------------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  await api.call(call('session.create', { cwd: '/tmp/elsewhere' }))
  const sc = sessionCreates(calls)
  check(
    '显式 cwd: 不注册、不注入 workspaceId、cwd 原样转发',
    workspaceCreates(calls).length === 0 && sc.length === 1 &&
      sc[0].args.request.cwd === '/tmp/elsewhere' && !hasWorkspaceId(sc[0].args.request),
    JSON.stringify(calls.map((c) => c.args)),
  )
}

// --- spec: 配置目录不存在导致注册被拒 ---------------------------------------
{
  const { calls, gateway } = makeGateway({
    onCreate: () => { throw coded('workspace/invalid-path', 'path does not exist') },
  })
  const warnings = []
  const api = createRemoteHostApi(gateway, connection, undefined, {
    workspacePath: WS_PATH,
    warn: (m) => warnings.push(m),
  })
  const result = await api.call(call('session.create', {}))
  const sc = sessionCreates(calls)
  check(
    '注册失败: 会话仍创建成功且不含 workspaceId',
    result.ok === true && result.value.sessionId === 'session-1' &&
      sc.length === 1 && !hasWorkspaceId(sc[0].args.request),
    JSON.stringify(result),
  )
  check(
    '注册失败: 输出一行含配置路径的诊断日志',
    warnings.length === 1 && warnings[0].includes(WS_PATH),
    JSON.stringify(warnings),
  )
}

// --- spec: 失败后恢复可用时重新尝试 -----------------------------------------
{
  let attempt = 0
  const { calls, gateway } = makeGateway({
    onCreate: () => {
      attempt += 1
      if (attempt === 1) throw coded('workspace/invalid-path', 'path does not exist')
      return OK_CREATE
    },
  })
  const api = createRemoteHostApi(gateway, connection, undefined, {
    workspacePath: WS_PATH,
    warn: () => {},
  })
  await api.call(call('session.create', {}))
  const second = await api.call(call('session.create', {}))
  check(
    '失败未固化: 第二次重新注册并成功注入',
    workspaceCreates(calls).length === 2 &&
      sessionCreates(calls)[1].args.request.workspaceId === WS_ID && second.ok === true,
    JSON.stringify(calls.map((c) => c.args)),
  )
}

// --- 返回值缺 workspaceId 视为解析失败 --------------------------------------
{
  const { calls, gateway } = makeGateway({ onCreate: () => ({ created: true }) })
  const warnings = []
  const api = createRemoteHostApi(gateway, connection, undefined, {
    workspacePath: WS_PATH,
    warn: (m) => warnings.push(m),
  })
  const result = await api.call(call('session.create', {}))
  check(
    '返回值缺 workspaceId: 视为失败、不注入、会话仍成功',
    result.ok === true && !hasWorkspaceId(sessionCreates(calls)[0].args.request) && warnings.length === 1,
    JSON.stringify({ result, warnings }),
  )
}

// --- 陈旧缓存: 被 workspace/not-found 拒绝后重试一次 ------------------------
{
  let sessionAttempt = 0
  const { calls, gateway } = makeGateway({
    onCreateSession: () => {
      sessionAttempt += 1
      if (sessionAttempt === 1) throw coded('workspace/not-found', `workspace "${WS_ID}" not found`)
      return { sessionId: 'session-2' }
    },
  })
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  const result = await api.call(call('session.create', {}))
  const sc = sessionCreates(calls)
  check(
    '陈旧缓存: 用原始请求重试一次并成功',
    result.ok === true && result.value.sessionId === 'session-2' &&
      sc.length === 2 && sc[0].args.request.workspaceId === WS_ID && !hasWorkspaceId(sc[1].args.request),
    JSON.stringify({ result, args: sc.map((c) => c.args) }),
  )
  const before = workspaceCreates(calls).length
  await api.call(call('session.create', {}))
  check(
    '陈旧缓存: 缓存已清空,下次重新注册',
    workspaceCreates(calls).length === before + 1,
    `workspace.create count ${workspaceCreates(calls).length}`,
  )
}

// --- 重试仍失败: 不无限重试 -------------------------------------------------
{
  const { calls, gateway } = makeGateway({
    onCreateSession: () => { throw coded('workspace/not-found', 'gone') },
  })
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  const result = await api.call(call('session.create', {}))
  check(
    '重试仍失败: 返回失败且恰好尝试两次',
    result.ok === false && sessionCreates(calls).length === 2,
    JSON.stringify({ result, count: sessionCreates(calls).length }),
  )
}

// --- 非 session.create 方法不受影响 -----------------------------------------
{
  const { calls, gateway } = makeGateway()
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: WS_PATH })
  await api.call(call('session.prompt', { sessionId: 'session-9', content: [] }))
  const pc = calls.filter((c) => c.namespace === 'session' && c.method === 'prompt')
  check(
    'session.prompt: 不触发注册、不注入 workspaceId',
    workspaceCreates(calls).length === 0 && pc.length === 1 && !hasWorkspaceId(pc[0].args.request),
    JSON.stringify(calls.map((c) => c.args)),
  )
}

rmSync(bundlePath, { force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
