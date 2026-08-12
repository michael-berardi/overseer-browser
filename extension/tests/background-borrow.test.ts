import { describe, expect, it, vi } from 'vitest';

function storageArea(store: Record<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: async (key: string) => delete store[key],
  };
}

describe('native tab borrowing approval', () => {
  it('rejects arbitrary native borrowing but permits the popup user-gesture path', async () => {
    const localStore: Record<string, unknown> = {};
    const sessionStore: Record<string, unknown> = {};
    const tabs = new Map<number, chrome.tabs.Tab>([
      [11, { id: 11, windowId: 10, url: 'about:blank', title: 'Agent', active: true }],
      [99, { id: 99, windowId: 20, url: 'https://example.test/', title: 'Example', active: true }],
    ]);
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const browserStub = {
      storage: { local: storageArea(localStore), session: storageArea(sessionStore) },
      permissions: {
        contains: async ({ origins }: { origins: string[] }) => origins.length === 1 && origins[0] === 'https://example.test/*',
        request: async () => true,
        remove: async () => true,
      },
      windows: {
        create: async () => ({ id: 10, tabs: [{ id: 11, windowId: 10, url: 'about:blank', active: true }] }),
        get: async (id: number) => ({ id }),
        remove: async () => undefined,
        update: async (id: number, updates: chrome.windows.UpdateInfo) => ({ id, ...updates }),
      },
      tabs: {
        query: async (query: chrome.tabs.QueryInfo) => query.active ? [tabs.get(99)!] : query.windowId === 10 ? [tabs.get(11)!] : [...tabs.values()],
        get: async (id: number) => tabs.get(id) ?? ({ id, windowId: 10, url: 'about:blank', active: false } as chrome.tabs.Tab),
        create: async () => ({ id: 12, windowId: 10, url: 'about:blank', active: true } as chrome.tabs.Tab),
        update: async (id: number, updates: chrome.tabs.UpdateProperties) => Object.assign(tabs.get(id) ?? { id }, updates),
        remove: async (id: number) => tabs.delete(id),
      },
      runtime: {
        onMessage: { addListener: vi.fn() },
        connectNative: () => port,
        getURL: (path: string) => path,
      },
    };
    vi.stubGlobal('browser', browserStub);
    vi.stubGlobal('chrome', browserStub);
    vi.stubGlobal('defineBackground', (callback: () => void) => callback());

    const background = await import('../entrypoints/background');
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake' })).toBe(4_000);
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake_ack', ok: 'yes' })).toBe(4_000);
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake_ack', ok: true })).toBe(250);

    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'borrow', command: 'tabs.borrow', params: { tab_id: 99 } }, { cancelled: false }))
      .rejects.toMatchObject({ code: 'operator_approval_required' });
    await expect(background.popupBorrowActive()).resolves.toMatchObject({ ok: true });
    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'borrow-again', command: 'tabs.borrow', params: { tab_id: 99 } }, { cancelled: false }))
      .resolves.toMatchObject({ id: 99 });
  });
});
