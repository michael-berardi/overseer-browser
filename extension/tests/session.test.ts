import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session';

const tabStore = new Map<number, chrome.tabs.Tab>([
  [20, { id: 20, windowId: 99, url: 'https://meet.google.com/abc-defg-hij', active: false }],
  [21, { id: 21, windowId: 10, url: 'about:blank', active: false }],
]);
const sessionStore: Record<string, unknown> = {};

vi.stubGlobal('browser', {
  storage: {
    session: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in sessionStore).map((key) => [key, sessionStore[key]])),
      set: async (values: Record<string, unknown>) => Object.assign(sessionStore, values),
      remove: async (key: string) => delete sessionStore[key],
    },
  },
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
    update: async (id: number, updates: chrome.tabs.UpdateProperties) => {
      const updated = { ...(tabStore.get(id) ?? { id }), ...updates } as chrome.tabs.Tab;
      tabStore.set(id, updated);
      return updated;
    },
    remove: async (id: number) => tabStore.delete(id),
  },
});

describe('session ownership', () => {
  it('owns Agent Window tabs and explicitly borrowed tabs, then returns borrowed tabs on stop', async () => {
    const manager = new SessionManager();
    const started = await manager.start();
    expect(started.agentWindowId).toBe(10);
    expect(started.started).toBe(true);
    expect(await manager.ownsTab(11)).toBe(true);
    expect(await manager.ownsTab(21)).toBe(true);
    tabStore.set(21, { id: 21, windowId: 99, url: 'about:blank', active: false });
    expect(await manager.ownsTab(21)).toBe(false);
    await manager.borrowTab(20);
    expect(await manager.ownsTab(20)).toBe(true);
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
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
  });

  it('preserves a bounded session name and rejects a conflicting active name', async () => {
    delete sessionStore['overseer.session.v1'];
    const manager = new SessionManager();

    const started = await manager.start('qa-session');

    expect(started.name).toBe('qa-session');
    await expect(manager.start('different-session')).rejects.toMatchObject({ code: 'session_conflict' });
    await manager.stop();
    await expect(manager.start('x'.repeat(65))).rejects.toMatchObject({ code: 'invalid_session_name' });
  });

  it('returns the updated active tab after selection', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.set(21, { id: 21, windowId: 10, url: 'about:blank', active: false });
    const manager = new SessionManager();
    await manager.start();

    const selected = await manager.selectTab(21);

    expect(selected.active).toBe(true);
    expect((await manager.requireState()).selectedTabId).toBe(21);
    await manager.stop();
  });

  it('normalizes selection when Chrome returns the pre-update tab snapshot', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.set(21, { id: 21, windowId: 10, url: 'about:blank', active: false });
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValueOnce(
      { id: 21, windowId: 10, url: 'about:blank', active: false },
    );
    const manager = new SessionManager();
    await manager.start();

    const selected = await manager.selectTab(21);

    expect(selected.active).toBe(true);
    update.mockRestore();
    await manager.stop();
  });
  it('restores a borrowed tab before return and releases ownership when restoration fails', async () => {
    delete sessionStore['overseer.session.v1'];
    const events: string[] = [];
    let manager!: SessionManager;
    manager = new SessionManager(async (tabId) => {
      expect((await manager.requireState()).borrowedTabIds).toContain(tabId);
      events.push(`release:${tabId}`);
      throw new Error('console restoration failed');
    });
    await manager.start();
    await manager.borrowTab(20);
    await expect(manager.returnTab(20)).resolves.toEqual({ returned: true });
    expect(events).toEqual(['release:20']);
    expect((await manager.requireState()).borrowedTabIds).not.toContain(20);
    await manager.stop();
  });

  it('restores borrowed tabs before session ownership is removed', async () => {
    delete sessionStore['overseer.session.v1'];
    const events: string[] = [];
    let manager!: SessionManager;
    manager = new SessionManager(async (tabId) => {
      expect((await manager.requireState()).borrowedTabIds).toContain(tabId);
      events.push(`release:${tabId}`);
      throw new Error('console restoration failed');
    });
    await manager.start();
    await manager.borrowTab(20);
    await expect(manager.stop()).resolves.toMatchObject({ stopped: true, returnedTabIds: [20] });
    expect(events).toEqual(['release:20']);
    expect(sessionStore['overseer.session.v1']).toBeUndefined();
  });

  it('refuses to close a borrowed user tab', async () => {
    delete sessionStore['overseer.session.v1'];
    const manager = new SessionManager();
    await manager.start();
    await manager.borrowTab(20);

    await expect(manager.closeTab(20)).rejects.toMatchObject({ code: 'borrowed_tab_close_forbidden' });
    expect(tabStore.has(20)).toBe(true);
    await manager.stop();
  });

  it('refuses to close the last Agent Window tab', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.delete(21);
    const manager = new SessionManager();
    await manager.start();

    await expect(manager.closeTab(11)).rejects.toMatchObject({
      code: 'last_owned_tab_close_forbidden',
      fallback: 'Navigate the existing tab or create another owned tab before closing it.',
    });
    await manager.stop();
  });

  it('reconciles the selected target with an active tab opened by the page', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.set(22, { id: 22, windowId: 10, url: 'https://example.com/report', active: true });
    const query = vi.spyOn(browser.tabs, 'query').mockResolvedValue([
      { id: 22, windowId: 10, url: 'https://example.com/report', active: true },
    ]);
    const manager = new SessionManager();
    await manager.start();

    await expect(manager.getSelectedTabId()).resolves.toBe(22);
    expect((await manager.requireState()).selectedTabId).toBe(22);
    query.mockRestore();
    tabStore.delete(22);
    await manager.stop();
  });

  it('clears persisted state when the dedicated window has closed', async () => {
    delete sessionStore['overseer.session.v1'];
    const manager = new SessionManager();
    await manager.start();
    const get = vi.spyOn(browser.windows, 'get').mockRejectedValueOnce(new Error('No window'));

    await expect(manager.list()).resolves.toEqual([]);
    expect(sessionStore['overseer.session.v1']).toBeUndefined();
    get.mockRestore();
  });

  it('does not clear a replacement session after a stale window check fails', async () => {
    delete sessionStore['overseer.session.v1'];
    const manager = new SessionManager();
    await manager.start('original');
    let rejectWindowCheck!: (reason?: unknown) => void;
    const staleWindowCheck = new Promise<chrome.windows.Window>((_resolve, reject) => {
      rejectWindowCheck = reject;
    });
    const get = vi.spyOn(browser.windows, 'get')
      .mockReturnValueOnce(staleWindowCheck)
      .mockResolvedValue({ id: 10 });
    const staleList = manager.list();
    await Promise.resolve();

    await manager.stop();
    const replacement = await manager.start('replacement');
    rejectWindowCheck(new Error('Original window closed'));

    await expect(staleList).resolves.toEqual([expect.objectContaining({ sessionId: replacement.sessionId, name: 'replacement' })]);
    expect(sessionStore['overseer.session.v1']).toEqual(expect.objectContaining({ sessionId: replacement.sessionId }));
    get.mockRestore();
    await manager.stop();
  });

  it('serializes concurrent closes so one owned tab always remains', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.clear();
    tabStore.set(11, { id: 11, windowId: 10, url: 'about:blank', active: true });
    const query = vi.spyOn(browser.tabs, 'query').mockImplementation(async (details) => (
      [...tabStore.values()].filter((tab) => details.windowId === undefined || tab.windowId === details.windowId)
    ));
    const manager = new SessionManager();
    await manager.start();
    const second = await manager.createTab();

    const outcomes = await Promise.allSettled([manager.closeTab(11), manager.closeTab(second.id!)]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'last_owned_tab_close_forbidden' }) }),
    ]);
    expect((await manager.requireState()).ownedTabIds).toHaveLength(1);
    query.mockRestore();
    await manager.stop();
  });

  it('coalesces concurrent tab refreshes and skips unchanged session writes', async () => {
    delete sessionStore['overseer.session.v1'];
    tabStore.clear();
    tabStore.set(11, { id: 11, windowId: 10, url: 'about:blank', active: true });
    const query = vi.spyOn(browser.tabs, 'query').mockImplementation(async (details) => (
      [...tabStore.values()].filter((tab) => details.windowId === undefined || tab.windowId === details.windowId)
    ));
    const persist = vi.spyOn(browser.storage.session, 'set');
    const manager = new SessionManager();
    await manager.start();
    query.mockClear();
    persist.mockClear();

    await Promise.all(Array.from({ length: 32 }, () => manager.listTabs()));

    expect(query).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    await manager.listTabs();
    expect(query).toHaveBeenCalledTimes(2);
    expect(persist).not.toHaveBeenCalled();
    query.mockRestore();
    persist.mockRestore();
    await manager.stop();
  });

  it('retries an offscreen resize on the primary display', async () => {
    delete sessionStore['overseer.session.v1'];
    const update = vi.spyOn(browser.windows, 'update')
      .mockRejectedValueOnce(new Error('Bounds must be within visible screen space'))
      .mockResolvedValueOnce({ id: 10, width: 500, height: 812, left: 0, top: 0 } as chrome.windows.Window);
    const manager = new SessionManager();
    await manager.start();

    await expect(manager.resize({ width: 500, height: 812 })).resolves.toMatchObject({ left: 0, top: 0 });
    expect(update).toHaveBeenNthCalledWith(2, 10, { width: 500, height: 812, left: 0, top: 0 });
    update.mockRestore();
    await manager.stop();
  });
});
