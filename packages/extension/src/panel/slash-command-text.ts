/**
 * Panel-owned copy for the slash-command surface, in both UI languages.
 *
 * Host command names and descriptions are NOT here: they are dsh's own domain
 * vocabulary and cross the wire as data, so the panel renders them verbatim
 * rather than translating someone else's words. Only text this panel authors —
 * its refusals, its placeholders and its diagnostics — is localized.
 *
 * @module
 */

import { getUiLocale, type UiLocale } from '../i18n.ts'

const locale: UiLocale = getUiLocale()

/**
 * Pick the copy for the active UI language.
 * @param english - the English string.
 * @param chinese - the Chinese string.
 * @returns the string for the browser's resolved language.
 */
export function localized(english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

/** The `aria-label` of the command overlay. */
export function menuLabel(): string {
  return localized('dsh slash commands', 'dsh 斜杠命令')
}

/** Placeholder shown while a command's paired result event is still pending. */
export function commandPending(): string {
  return localized('running…', '执行中…')
}

/**
 * Refusal when the command catalog itself could not be read. The draft is kept
 * because the command may well exist — the panel simply cannot confirm it, and
 * guessing would either run the wrong thing or spend tokens on a command line.
 * @param name - command name without the leading slash.
 * @param reason - the catalog failure already rendered into words.
 * @returns the notice shown in the transcript.
 */
export function catalogUnavailableNotice(name: string, reason: string | null): string {
  if (reason !== null) return reason
  return localized(
    `Command list unavailable; /${name} was not sent`,
    `命令目录不可用，未发送 /${name}`,
  )
}

/**
 * Reason line for a failed catalog read.
 * @param code - the transport's stable error code, when it attached one.
 * @param reason - the underlying message.
 * @returns the line shown in the transcript.
 */
export function catalogFailure(code: string | undefined, reason: string): string {
  const prefix = localized('Command list unavailable', '命令目录不可用')
  return code === undefined ? `${prefix}: ${reason}` : `${prefix} [${code}]: ${reason}`
}

/**
 * Notice for an execute request the bridge rejected. No lifecycle event will
 * follow such a rejection, so this is the only explanation the user gets.
 * @param reason - the rejection already rendered into words.
 * @returns the notice shown in the transcript.
 */
export function commandRejectedNotice(reason: string): string {
  return localized(`Command failed: ${reason}`, `命令执行失败: ${reason}`)
}

/**
 * Diagnostics line for an execute request that outlived the client's RPC
 * budget. The host may still be running it, so the durable lifecycle events
 * remain the outcome and this is only a trace.
 * @param line - the command line that was sent.
 * @returns the log line.
 */
export function commandTimeoutLog(line: string): string {
  return localized(
    `command ${line} did not answer within the RPC budget; the event stream owns the result`,
    `命令 ${line} 未在 RPC 时限内应答，结果以事件流为准`,
  )
}

/** Menu row shown while the bound session's catalog is being read. */
export function menuLoading(): string {
  return localized('Loading commands…', '正在加载命令…')
}

/**
 * Menu row shown while the panel is creating the session it needs to resolve
 * commands against. Commands are resolved per session, so the "new session"
 * state has nothing to ask about until one exists — and opening the menu is the
 * interaction that creates it.
 */
export function menuCreatingSession(): string {
  return localized('Starting a session…', '正在创建会话…')
}

/**
 * Menu row shown when the catalog read failed, or when the bridge is not
 * connected so no read can be issued at all. Naming one of these beats an empty
 * menu: silence is indistinguishable from "this panel knows no commands", which
 * is the one conclusion that is always wrong.
 */
export function menuUnavailable(): string {
  return localized('Command list unavailable — reconnect to retry', '命令目录不可用，重连后重试')
}

/** Menu row shown when the draft matches no command in the catalog. */
export function menuNoMatch(): string {
  return localized('No matching command', '没有匹配的命令')
}

/**
 * Marker on a skill only the user may invoke. Mirrors dsh's own menu wording so
 * the same skill reads the same way in both surfaces.
 */
export function userOnlyMarker(): string {
  return localized('user-only', '仅用户')
}
