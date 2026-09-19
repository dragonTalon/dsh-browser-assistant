#!/usr/bin/env node
/**
 * Unified test runner: executes every check in the manifest and prints a
 * summary.
 *
 * The repo has no test framework; each check in the manifest is a standalone
 * Node script that bundles the REAL sources with esbuild and asserts in Node
 * (see the individual headers for what each covers). This runner is the single
 * entry point that runs them all, so a release can be gated on one command
 * instead of on remembering which `check:*` scripts exist.
 *
 * Layers:
 *   OFFLINE_CHECKS  — no dsh, no Chrome, no network required (default run).
 *   E2E_CHECKS      — speak the real wire protocol against a RUNNING local dsh;
 *                     included only with --e2e.
 *
 * Diagnostics and tools (probe, switch-tier, grouping-status, release-notes,
 * sync-profile) are deliberately NOT part of the manifest: they are manual
 * aids, not assertions.
 *
 * Usage: node scripts/run-tests.mjs [--e2e]
 * Exit code: 0 all passed, 1 one or more failed, 2 usage error.
 *
 * @module
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One check entry. `file` is repo-root relative; `nodeArgs` are prepended to
 * the file (e.g. the strip-types flag for the one TypeScript check).
 */
const OFFLINE_CHECKS = [
  { name: 'session-grouping', file: 'scripts/check-session-grouping.mjs' },
  { name: 'grouping-lifecycle', file: 'scripts/check-grouping-lifecycle.mjs' },
  { name: 'ordered-rpc', file: 'scripts/check-ordered-rpc.mjs' },
  { name: 'session-selection', file: 'scripts/check-session-selection.mjs' },
  { name: 'slash-command', file: 'scripts/check-slash-command.mjs' },
  { name: 'permission-tiers', file: 'scripts/check-permission-tiers.mjs' },
  { name: 'tool-registry', file: 'scripts/check-tool-registry.mjs' },
  { name: 'adapter-seam', file: 'scripts/check-adapter-seam.mjs' },
  { name: 'endpoint-normalization', file: 'scripts/check-endpoint.mts', nodeArgs: ['--experimental-strip-types'] },
]

/** Checks that need a running dsh on this machine; only run with --e2e. */
const E2E_CHECKS = [
  { name: 'session-grouping-e2e', file: 'scripts/check-session-grouping-e2e.mjs' },
  { name: 'session-selection-e2e', file: 'scripts/check-session-selection-e2e.mjs' },
]

const withE2e = process.argv.includes('--e2e')
if (process.argv.some((arg) => arg.startsWith('-') && arg !== '--e2e')) {
  console.error('usage: node scripts/run-tests.mjs [--e2e]')
  process.exit(2)
}

const checks = withE2e ? [...OFFLINE_CHECKS, ...E2E_CHECKS] : OFFLINE_CHECKS
const results = []
for (const entry of checks) {
  const started = Date.now()
  console.log(`\n=== ${entry.name} (${entry.file}) ===`)
  const run = spawnSync(process.execPath, [...(entry.nodeArgs ?? []), join(repoRoot, entry.file)], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  const failed = run.status === null || run.status !== 0
  results.push({ ...entry, failed, ms: Date.now() - started, status: run.status })
}

console.log('\n=== summary ===')
let failedCount = 0
for (const result of results) {
  failedCount += result.failed ? 1 : 0
  const mark = result.failed ? 'FAIL' : 'pass'
  const code = result.status === null ? 'signal' : String(result.status)
  console.log(`  ${mark}  ${result.name.padEnd(24)} ${code}  (${result.ms}ms)`)
}
console.log(failedCount === 0
  ? `\nall ${results.length} check(s) passed`
  : `\n${failedCount}/${results.length} check(s) FAILED`)
process.exit(failedCount === 0 ? 0 : 1)
