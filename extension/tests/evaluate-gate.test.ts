import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function event() {
  const listeners = new Set<Listener>();
  return {
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    emit: (...args: unknown[]) => listeners.forEach((listener) => listener(...args)),
  };
}

function storageArea(store: Record<string, unknown>) {
  return {
    get: async (keys: string[] | null) => Object.fromEntries((keys ?? Object.keys(store)).filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: async (key: string) => delete store[key],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadBackground(borrowedTabIds: number[] = []) {
  const sessionStore: Record<string, unknown> = borrowedTabIds.length ? {
    'overseer.session.v1': {
      sessionId: 'fixture-session', agentWindowId: 10, ownedTabIds: [11], borrowedTabIds,
      selectedTabId: 11, startedAtMs: 1_700_000_000_000,
    },
  } : {};
  const tabs = new Map<number, chrome.tabs.Tab>([
    [11, { id: 11, windowId: 10, url: 'https://example.test/owned', title: 'Owned', active: true, status: 'complete' } as chrome.tabs.Tab],
    [12, { id: 12, windowId: 20, url: 'https://example.test/borrowed', title: 'Borrowed', active: true, status: 'complete' } as chrome.tabs.Tab],
  ]);
  const userScriptsExecute = vi.fn(async () => [{ result: { ok: true, value: 'evaluated' } }]);
  const scriptingExecute = vi.fn(async () => [{ result: { ok: true, value: 'evaluated' } }]);
  const browserStub = {
    storage: {
      local: storageArea({
        'overseer.connection.enabled.v1': false,
        'overseer.capability.evaluate.v1': false,
        'overseer.site.unlimited.v2': true,
      }),
      session: storageArea(sessionStore),
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('tab missing');
        return tab;
      }),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) => [...tabs.values()].filter((tab) => tab.windowId === query.windowId)),
      create: vi.fn(),
      update: vi.fn(),
    },
    runtime: { onMessage: event(), connectNative: vi.fn(), getURL: (path: string) => path },
    windows: { get: async (id: number) => ({ id }), create: async () => ({ id: 10, tabs: [{ id: 11, windowId: 10, url: 'about:blank', active: true }] }) },
    scripting: { executeScript: scriptingExecute },
    userScripts: { execute: userScriptsExecute, getScripts: vi.fn(async () => []) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
  };
  vi.stubGlobal('browser', browserStub);
  vi.stubGlobal('chrome', browserStub);
  vi.stubGlobal('defineBackground', (callback: () => void) => callback());
  vi.resetModules();
  const background = await import('../entrypoints/background');
  await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
  return { background, tabs, userScriptsExecute };
}

function evaluate(tabId: number, source = '1') {
  return { version: 1 as const, kind: 'request' as const, request_id: `eval-${tabId}`, command: 'evaluate' as const, params: { tab_id: tabId, source } };
}

describe('evaluate capability gate', () => {
  it('allows evaluate in the session-owned Agent Window without the popup grant', async () => {
    const { background, userScriptsExecute } = await loadBackground();

    await expect(background.dispatch(evaluate(11), { cancelled: false })).resolves.toBe('evaluated');
    expect(userScriptsExecute).toHaveBeenCalled();
  });

  it('refuses evaluate in a borrowed tab without the popup grant', async () => {
    const { background, userScriptsExecute } = await loadBackground([12]);

    await expect(background.dispatch(evaluate(12), { cancelled: false })).rejects.toMatchObject({ code: 'capability_required' });
    expect(userScriptsExecute).not.toHaveBeenCalled();
  });

  it('refuses unsupported schemes before the capability gate', async () => {
    const { background, tabs, userScriptsExecute } = await loadBackground();
    tabs.set(11, { ...tabs.get(11)!, url: 'about:blank' } as chrome.tabs.Tab);

    await expect(background.dispatch(evaluate(11), { cancelled: false })).rejects.toMatchObject({ code: 'unsupported_page' });
    expect(userScriptsExecute).not.toHaveBeenCalled();
  });
});
