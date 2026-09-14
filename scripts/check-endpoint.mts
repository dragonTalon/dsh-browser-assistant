#!/usr/bin/env node
/**
 * 归一化自检：把面板里用户可能输入的地址形态跑一遍，确认 `resolveBridgeHost`
 * 与 `normalizeBridgeToken` 的结果符合预期。
 *
 * 用法：node --experimental-strip-types scripts/check-endpoint.mts
 * （仓库没有测试套件，这是纯手工验证工具，与 scripts/probe.mjs 同性质。）
 *
 * @module
 */

import { normalizeBridgeToken, resolveBridgeHost } from '../packages/protocol/src/endpoint.ts'

interface HostCase {
  input: string
  /** 期望的 url；`''` 表示「本机自动发现」，`err:<code>` 表示应被拒绝。 */
  expect: string
  loopback?: boolean
  plaintext?: boolean
}

const HOST_CASES: HostCase[] = [
  { input: '', expect: '', loopback: true },
  { input: '   ', expect: '', loopback: true },
  { input: '10.0.0.7:3080', expect: 'ws://10.0.0.7:3080/ext/bridge', plaintext: true },
  { input: '127.0.0.1:3080', expect: 'ws://127.0.0.1:3080/ext/bridge', loopback: true },
  { input: 'localhost:3080', expect: 'ws://localhost:3080/ext/bridge', loopback: true },
  { input: 'wss://dsh.example.com', expect: 'wss://dsh.example.com/ext/bridge' },
  { input: 'ws://10.0.0.7:3080/ext/bridge', expect: 'ws://10.0.0.7:3080/ext/bridge', plaintext: true },
  { input: 'wss://dsh.example.com/dsh/ext/bridge', expect: 'wss://dsh.example.com/dsh/ext/bridge' },
  { input: 'http://10.0.0.7:3080', expect: 'ws://10.0.0.7:3080/ext/bridge', plaintext: true },
  { input: 'https://dsh.example.com', expect: 'wss://dsh.example.com/ext/bridge' },
  { input: 'ftp://10.0.0.7:3080', expect: 'err:unsupported-scheme' },
  { input: 'file:///etc/passwd', expect: 'err:unsupported-scheme' },
  { input: '10.0.0.7:99999', expect: 'err:invalid-port' },
  { input: '10.0.0.7:0', expect: 'err:invalid-port' },
  { input: 'ws://10.0.0.7:99999/ext/bridge', expect: 'err:invalid-url' },
  { input: 'not a host', expect: 'err:invalid-url' },
  { input: ':::', expect: 'err:invalid-url' },
  { input: 'ws://[::1]:3080', expect: 'ws://[::1]:3080/ext/bridge', loopback: true },
]

const TOKEN_CASES: { input: string; expect: string }[] = [
  { input: 'a3f9\n', expect: 'a3f9' },
  { input: '   ', expect: '' },
  { input: '\t abc \r\n', expect: 'abc' },
  { input: 'abc', expect: 'abc' },
]

let failed = 0
for (const testCase of HOST_CASES) {
  const resolved = resolveBridgeHost(testCase.input)
  const actual = resolved.ok ? resolved.url : `err:${resolved.code}`
  const reasons: string[] = []
  if (actual !== testCase.expect) reasons.push(`url ${JSON.stringify(actual)} != ${JSON.stringify(testCase.expect)}`)
  if (resolved.ok) {
    if (testCase.loopback !== undefined && resolved.loopback !== testCase.loopback) reasons.push(`loopback=${resolved.loopback}`)
    if (testCase.plaintext !== undefined && resolved.plaintext !== testCase.plaintext) reasons.push(`plaintext=${resolved.plaintext}`)
  }
  if (reasons.length > 0) failed += 1
  console.log(`${reasons.length === 0 ? 'PASS' : 'FAIL'}  host ${JSON.stringify(testCase.input)}${reasons.length === 0 ? '' : ` -> ${reasons.join('; ')}`}`)
}
for (const { input, expect } of TOKEN_CASES) {
  const actual = normalizeBridgeToken(input)
  const ok = actual === expect
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  token ${JSON.stringify(input)} -> ${JSON.stringify(actual)} (expect ${JSON.stringify(expect)})`)
}
console.log(failed === 0 ? '\nall cases pass' : `\n${failed} case(s) failed`)
process.exit(failed === 0 ? 0 : 1)
