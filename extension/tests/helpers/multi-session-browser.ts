import { vi } from 'vitest';

type Listener = (...args: any[]) => void;
function event() {
  const listeners = new Set<Listener>();
  return { addListener: (listener: Listener) => listeners.add(listener), removeListener: (listener: Listener) => listeners.delete(listener), emit: (...args: any[]) => listeners.forEach((listener) => listener(...args)) };
}

export function mockMultiSessionBrowser() {
  const storage: Record<string, unknown> = {};
  const local: Record<string, unknown> = { 'overseer.connection.enabled.v1': false, 'overseer.site.unlimited.v2': true, 'overseer.capability.evaluate.v1': true };
  const area = (store: Record<string, unknown>) => ({
    get: vi.fn(async (keys: string[] | null) => structuredClone(Object.fromEntries((keys ?? Object.keys(store)).filter((key) => key in store).map((key) => [key, store[key]])))),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); }),
    remove: vi.fn(async (key: string) => { delete store[key]; }),
  });
  const tabs = new Map<number, chrome.tabs.Tab>([[1, { id: 1, windowId: 1, url: 'https://operator.test/', active: true }]]);
  const windows = new Set<number>([1]);
  let tabSequence = 10;
  let windowSequence = 10;
  let focusedWindow = 1;
  const makeTab = (windowId: number, url = 'about:blank') => {
    for (const tab of tabs.values()) if (tab.windowId === windowId) tab.active = false;
    const tab: chrome.tabs.Tab = { id: ++tabSequence, windowId, url, active: true, status: 'complete' };
    tabs.set(tab.id!, tab);
    return { ...tab };
  };
  const port = { onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() };
  const stub = {
    storage: { local: area(local), session: area(storage) },
    windows: {
      create: vi.fn(async () => { const id = ++windowSequence; windows.add(id); return { id, tabs: [makeTab(id)] }; }),
      get: vi.fn(async (id: number) => { if (!windows.has(id)) throw new Error('window closed'); return { id }; }),
      remove: vi.fn(async (id: number) => { windows.delete(id); for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId); }),
      update: vi.fn(async (id: number, updates: chrome.windows.UpdateInfo) => { if (updates.focused) focusedWindow = id; return { id, ...updates }; }),
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      get: vi.fn(async (id: number) => { const tab = tabs.get(id); if (!tab) throw new Error('tab closed'); return { ...tab }; }),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) => [...tabs.values()].filter((tab) =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (!query.active || tab.active) && (!query.lastFocusedWindow || tab.windowId === focusedWindow)).map((tab) => ({ ...tab }))),
      create: vi.fn(async (details: chrome.tabs.CreateProperties) => makeTab(details.windowId!, details.url)),
      update: vi.fn(async (id: number, updates: chrome.tabs.UpdateProperties) => {
        const tab = tabs.get(id)!;
        if (updates.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
        Object.assign(tab, updates);
        return { ...tab };
      }),
      remove: vi.fn(async (id: number) => { tabs.delete(id); }),
    },
    runtime: { onMessage: event(), connectNative: vi.fn(() => port), getManifest: () => ({ version: '0.3.0' }), getURL: (path: string) => path },
    permissions: { contains: vi.fn(async () => true), remove: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn<(...args: any[]) => Promise<any[]>>(async () => [{ result: { ok: true, value: [] } }]) },
    userScripts: { getScripts: vi.fn(async () => []) },
  };
  vi.stubGlobal('browser', stub);
  vi.stubGlobal('chrome', stub);
  vi.stubGlobal('defineBackground', (callback: () => void) => callback());
  return { stub, storage, local, tabs, windows, port };
}
