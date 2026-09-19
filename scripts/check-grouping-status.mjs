#!/usr/bin/env node
/**
 * Live diagnosis of dsh's Workspace registry against the bridge's configured
 * Session workspace — the two facts that decide whether an extension-created
 * conversation shows up grouped in the dsh sidebar.
 *
 * Read-only: reads the persisted registry and the session store on disk.
 * Creates nothing, calls no RPC.
 *
 * Usage: node scripts/check-grouping-status.mjs [workspacePath]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const WORKSPACE_PATH = resolve(process.argv[2] ?? process.cwd())
const WORKSPACE_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json')
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/**
 * dsh's on-disk slug for a session directory. Each path separator and each
 * '.' becomes one '-', and the absolute path's own leading '/' is what turns
 * the two-bracket prefix into three leading dashes:
 *   /Users/x/packages/bridge-dsh -> ---Users-x-packages-bridge-dsh--
 */
const sessionDirSlug = (path) => `-${path.replace(/[/.]/g, '-')}--`

const registry = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
const workspaces = Object.entries(registry.tables.workspaces).map(([id, w]) => ({
  id, path: w.path, title: w.title, sessionIds: w.sessionIds ?? [],
}))
const archived = new Set(registry.global?.archivedSessionIds ?? [])

console.log(`configured Session workspace : ${WORKSPACE_PATH}`)
console.log(`registry                     : ${WORKSPACE_FILE}`)
console.log(`registry mtime               : ${statSync(WORKSPACE_FILE).mtime.toLocaleString()}`)
console.log(`\nworkspaces (${workspaces.length}):`)
for (const w of workspaces) {
  console.log(`  ${w.title.padEnd(24)} ${String(w.sessionIds.length).padStart(3)} sessions  ${w.path}`)
}

const target = workspaces.find((w) => w.path === WORKSPACE_PATH)
console.log()
if (target === undefined) {
  console.log('VERDICT  no Workspace holds this directory.')
  console.log('         Every extension-created Session stays in dsh\'s "ungrouped" bucket')
  console.log('         until the bridge registers it (that happens on session.create).')
} else {
  console.log(`VERDICT  Workspace "${target.title}" (${target.id}) holds ${target.sessionIds.length} Session(s).`)
}

// Every session dsh has ever stored under this directory, newest first.
const dir = join(SESSIONS_ROOT, sessionDirSlug(WORKSPACE_PATH))
let stored = []
try {
  stored = readdirSync(dir)
    .filter((name) => name.startsWith('session-'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
} catch {
  console.log(`\nno stored Sessions under ${dir}`)
  process.exit(target === undefined ? 1 : 0)
}

const held = new Set(target?.sessionIds ?? [])
const orphans = stored.filter((s) => !held.has(s.name))
console.log(`\nSessions stored in that directory : ${stored.length}`)
console.log(`   accounted by the Workspace     : ${stored.length - orphans.length}`)
console.log(`   NOT in the Workspace           : ${orphans.length}${orphans.some(o => archived.has(o.name)) ? ' (some archived)' : ''}`)
for (const orphan of orphans.slice(0, 12)) {
  console.log(`     ${orphan.name}  ${new Date(orphan.mtime).toLocaleString()}${archived.has(orphan.name) ? '  [archived]' : ''}`)
}
if (orphans.length > 12) console.log(`     … ${orphans.length - 12} more`)

process.exit(orphans.length === 0 && target !== undefined ? 0 : 1)
