import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session';

const tabStore = new Map<number, chrome.tabs.Tab>([
  [20, { id: 20, windowId: 99, url: 'https://meet.google.com/abc-defg-hij', active: false }],
  [21, { id: 21, windowId: 10, url: 'about:blank', active: false }],
]);
const localStore: Record<string, unknown> = {};
const sessionStore: Record<string, unknown> = {};

vi.stubGlobal('browser', {
  storage: {
    local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in localStore).map((key) => [key, localStore[key]])),
      set: async (values: Record<string, unknown>) => Object.assign(localStore, values),
      remove: async (key: string) => delete localStore[key],
    },
    session: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in sessionStore).map((key) => [key, sessionStore[key]])),
      set: async (values: Record<string, unknown>) => Object.assign(sessionStore, values),
      remove: async (key: string) => delete sessionStore[key],
    },
  },
  permissions: { contains: async () => false },
  windows: {
    create: vi.fn(async () => ({ id: 10, tabs: [{ id: 11, windowId: 10, url: 'about:blank', active: true }] })),
    get: async (id: number) => ({ id }),
    remove: async () => undefined,
    update: async (id: number, updates: chrome.windows.UpdateInfo) => ({ id, ...updates }),
  },
  tabs: {
    query: async (query: chrome.tabs.QueryInfo) => {
      if (query.windowId === 10) {
        const manuallyOpened = tabStore.get(21);
        return manuallyOpened ? [{ id: 11, windowId: 10, url: 'about:blank', active: true }, manuallyOpened] : [{ id: 11, windowId: 10, url: 'about:blank', active: true }];
      }
      return [...tabStore.values()];
    },
    create: async (details: chrome.tabs.CreateProperties) => {
      const tab = { id: 12, windowId: details.windowId, url: details.url, active: true } as chrome.tabs.Tab;
      tabStore.set(12, tab);
      return tab;
    },
    get: async (id: number) => tabStore.get(id) ?? ({ id, windowId: 10, url: 'about:blank', active: false } as chrome.tabs.Tab),
    update: async (id: number, updates: chrome.tabs.UpdateProperties) => Object.assign(tabStore.get(id) ?? { id }, updates),
    remove: async (id: number) => tabStore.delete(id),
  },
});

describe('session ownership', () => {
  it('owns Agent Window tabs and explicitly borrowed tabs, then returns borrowed tabs on stop', async () => {
    const manager = new SessionManager();
    const started = await manager.start();
    expect(started.agentWindowId).toBe(10);
    expect(await manager.ownsTab(11)).toBe(true);
    expect(await manager.ownsTab(21)).toBe(true);
    tabStore.set(21, { id: 21, windowId: 99, url: 'about:blank', active: false });
    expect(await manager.ownsTab(21)).toBe(false);
    localStore['overseer.automation.origins.v1'] = ['https://meet.google.com/*'];
    await manager.borrowTab(20);
    expect(await manager.ownsTab(20)).toBe(true);
    expect(localStore).toEqual({
      'overseer.automation.origins.v1': ['https://meet.google.com/*'],
    });
    expect(sessionStore['overseer.session.v1']).toBeDefined();
    const reloaded = new SessionManager();
    expect(await reloaded.ownsTab(11)).toBe(true);
    delete sessionStore['overseer.session.v1'];
    const afterBrowserRestart = new SessionManager();
    await expect(afterBrowserRestart.ownsTab(11)).rejects.toThrow('Start a browser session');
    const stopped = await manager.stop();
    expect(stopped.returnedTabIds).toEqual([20]);
    await expect(manager.ownsTab(20)).rejects.toThrow('Start a browser session');
  });

  it('serializes concurrent session starts into one Agent Window', async () => {
    delete sessionStore['overseer.session.v1'];
    const create = vi.mocked(browser.windows.create);
    create.mockClear();
    const manager = new SessionManager();

    const [first, second] = await Promise.all([manager.start(), manager.start()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.agentWindowId).toBe(first.agentWindowId);
  });
});
