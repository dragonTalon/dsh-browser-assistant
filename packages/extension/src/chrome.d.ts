/**
 * Minimal ambient types for the Chrome extension APIs this repo actually uses.
 *
 * There is no `@types/chrome` available offline (no npm registry access), so
 * this file declares exactly the surface the extension touches. It is NOT the
 * full Chrome API — add declarations only when a new API is adopted.
 *
 * @module
 */

declare namespace chrome {
  interface Event<T extends (...args: any[]) => any> {
    addListener(callback: T): void
    removeListener(callback: T): void
  }

  namespace runtime {
    interface Port {
      name: string
      disconnect(): void
      postMessage(message: unknown): void
      onDisconnect: Event<() => void>
      onMessage: Event<(message: unknown, port: Port) => void>
    }
    interface MessageSender {
      id?: string
      url?: string
      frameId?: number
      documentId?: string
      tab?: chrome.tabs.Tab
    }
    function connect(connectInfo?: { name?: string }): Port
    function sendMessage(message: unknown): Promise<unknown>
    const onConnect: Event<(port: Port) => void>
    const onMessage: Event<(message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined | void>
  }

  namespace tabs {
    interface Tab {
      id?: number
      index: number
      windowId: number
      active: boolean
      url?: string
      title?: string
      status?: string
    }
    interface OnUpdatedChangeInfo {
      url?: string
      status?: string
      title?: string
    }
    function query(queryInfo: { active?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function create(createProperties: { active?: boolean; url?: string; windowId?: number }): Promise<Tab>
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>
    function remove(tabId: number): Promise<void>
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }): Promise<unknown>
    function captureVisibleTab(windowId: number, options?: { format?: 'png' | 'jpeg' }): Promise<string>
    const onActivated: Event<(activeInfo: { tabId: number; windowId: number }) => void>
    const onUpdated: Event<(tabId: number, changeInfo: OnUpdatedChangeInfo, tab: Tab) => void>
  }

  namespace windows {
    const WINDOW_ID_NONE: number
    interface Window {
      id?: number
    }
    function getLastFocused(): Promise<Window>
    const onFocusChanged: Event<(windowId: number) => void>
  }

  namespace scripting {
    interface ScriptInjection {
      target: { tabId: number; allFrames?: boolean }
      files?: string[]
    }
    function executeScript(injection: ScriptInjection): Promise<unknown[]>
  }

  namespace storage {
    interface StorageArea {
      get(key?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
    }
    const local: StorageArea
  }

  namespace alarms {
    interface Alarm {
      name: string
    }
    function create(name: string, alarmInfo: { periodInMinutes?: number }): Promise<void>
    function clear(name: string): Promise<boolean>
    const onAlarm: Event<(alarm: Alarm) => void>
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick?: boolean }): Promise<void>
  }

  namespace webNavigation {
    interface GetAllFramesResultDetails {
      frameId: number
      parentFrameId: number
      documentId?: string
      url: string
      tabId: number
    }
    function getAllFrames(details: { tabId: number }): Promise<GetAllFramesResultDetails[] | null>
  }

  namespace i18n {
    function getUILanguage(): string
  }
}
