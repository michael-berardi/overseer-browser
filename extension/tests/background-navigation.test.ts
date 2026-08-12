import { describe, expect, it, vi } from 'vitest';

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
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: async (key: string) => delete store[key],
  };
}

async function loadBackground() {
  const onUpdated = event();
  const onRemoved = event();
  const browserStub = {
    storage: { local: storageArea({}), session: storageArea({}) },
    tabs: {
      onUpdated,
      onRemoved,
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://example.test/next' })),
      query: vi.fn<() => Promise<chrome.tabs.Tab[]>>(async () => []),
    },
    runtime: {
      onMessage: event(),
      connectNative: vi.fn(),
      getURL: (path: string) => path,
    },
    windows: {
      get: async (id: number) => ({ id }),
      create: async () => ({ id: 1, tabs: [{ id: 7, windowId: 1, url: 'about:blank' }] }),
    },
    scripting: { executeScript: vi.fn() },
  };
  vi.stubGlobal('browser', browserStub);
  vi.stubGlobal('chrome', browserStub);
  vi.stubGlobal('defineBackground', (callback: () => void) => callback());
  vi.resetModules();
  const background = await import('../entrypoints/background');
  return { background, onUpdated, onRemoved, browserStub };
}

describe('background navigation waits', () => {
  it('resolves on same-document URL updates without a complete status', async () => {
    vi.useFakeTimers();
    const { background, onUpdated, browserStub } = await loadBackground();
    const pending = background.createTabNavigationWait(7).promise;

    onUpdated.emit(7, { url: 'https://example.test/next#section' });
    await expect(pending).resolves.toEqual(expect.objectContaining({ id: 7 }));
    expect(browserStub.tabs.get).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it('waits for complete after an early cross-document loading URL event', async () => {
    vi.useFakeTimers();
    const { background, onUpdated, browserStub } = await loadBackground();
    const pending = background.createTabNavigationWait(7).promise;

    onUpdated.emit(7, { status: 'loading', url: 'https://cross-origin.test/previous' });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    onUpdated.emit(7, { status: 'complete' });
    await expect(pending).resolves.toEqual(expect.objectContaining({ id: 7 }));
    expect(browserStub.tabs.get).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });

  it('uses isolated-world history traversal for back and forward navigation', async () => {
    const { background, browserStub } = await loadBackground();

    await background.runHistoryNavigation(7, -1);
    await background.runHistoryNavigation(7, 1);

    expect(browserStub.scripting.executeScript).toHaveBeenNthCalledWith(1, expect.objectContaining({ target: { tabId: 7 }, world: 'ISOLATED', args: [-1] }));
    expect(browserStub.scripting.executeScript).toHaveBeenNthCalledWith(2, expect.objectContaining({ target: { tabId: 7 }, world: 'ISOLATED', args: [1] }));
  });

  it('preserves tab-close and navigation-timeout errors', async () => {
    vi.useFakeTimers();
    const { background, onRemoved } = await loadBackground();
    const closed = background.createTabNavigationWait(8).promise;
    onRemoved.emit(8);
    await expect(closed).rejects.toMatchObject({ code: 'tab_closed' });

    const timedOut = background.createTabNavigationWait(9).promise;
    vi.advanceTimersByTime(15_000);
    await expect(timedOut).rejects.toMatchObject({ code: 'navigation_timeout' });
    vi.useRealTimers();
  });
});

describe('background request cancellation', () => {
  it('stops a batch before its next action after the outer timeout cancels state', async () => {
    vi.useFakeTimers();
    const { background, browserStub } = await loadBackground();
    let releaseFirstAction!: () => void;
    const state = { cancelled: false };
    const firstAction = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseFirstAction = resolve; });
    const query = browserStub.tabs.query;
    query.mockReturnValueOnce(firstAction).mockResolvedValue([]);
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, state);
    const batch = background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'batch',
      command: 'batch',
      params: { actions: [{ command: 'tabs.list' }, { command: 'tabs.list' }] },
    }, state);
    const timedOut = background.withTimeout(batch, 100, () => { state.cancelled = true; });

    await Promise.resolve();
    vi.advanceTimersByTime(100);
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    releaseFirstAction();
    await expect(batch).rejects.toMatchObject({ code: 'cancelled' });
    expect(query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
