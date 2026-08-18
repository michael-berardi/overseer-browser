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

async function loadBackground(connectionReadFails = false) {
  const onUpdated = event();
  const onRemoved = event();
  const localStorage = storageArea({ 'overseer.connection.enabled.v1': false });
  const backgroundReady = Promise.withResolvers<void>();
  const getLocalValues = localStorage.get;
  const removeLocalValue = localStorage.remove;
  localStorage.remove = async (key: string) => {
    await removeLocalValue(key);
    backgroundReady.resolve();
  };
  if (connectionReadFails) {
    localStorage.get = async (keys: string[]) => {
      if (keys.includes('overseer.connection.enabled.v1')) throw new Error('storage unavailable');
      return getLocalValues(keys);
    };
  }
  const browserStub = {
    storage: { local: localStorage, session: storageArea({}) },
    tabs: {
      onUpdated,
      onRemoved,
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://example.test/next' })),
      create: vi.fn(async () => ({ id: 8, windowId: 1, url: 'https://example.test/next', status: 'loading' as const })),
      update: vi.fn(async (id: number, updates: chrome.tabs.UpdateProperties) => ({ id, windowId: 1, ...updates })),
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
  return { background, onUpdated, onRemoved, browserStub, backgroundReady: backgroundReady.promise };
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

  it('waits for a newly created URL tab to finish loading', async () => {
    const { background, onUpdated, browserStub } = await loadBackground();
    browserStub.tabs.get.mockResolvedValueOnce(
      { id: 8, windowId: 1, url: 'https://example.test/next', status: 'complete' },
    );
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });

    const pending = background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'new-tab',
      command: 'tabs.create',
      params: { url: 'https://example.test/next' },
    }, { cancelled: false });
    await vi.waitFor(() => expect(browserStub.tabs.update).toHaveBeenCalledWith(8, { url: 'https://example.test/next' }));
    onUpdated.emit(8, { status: 'complete' });

    await expect(pending).resolves.toMatchObject({ id: 8, status: 'complete' });
  });
  it('allows fill to clear an existing field value', async () => {
    const { background, browserStub } = await loadBackground();
    browserStub.scripting.executeScript.mockResolvedValueOnce([{ result: { ok: true, value: { changed: true } } }]);
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });

    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'clear-field',
      command: 'fill',
      params: { ref: 'osr-field', value: '' },
    }, { cancelled: false })).resolves.toEqual({ changed: true });
    expect(browserStub.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      args: [{ kind: 'fill', ref: 'osr-field', value: '' }, null],
    }));
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

  it('rejects unknown command parameters instead of silently ignoring them', async () => {
    const { background } = await loadBackground();

    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'invalid-observe-param',
      command: 'observe',
      params: { maxNodes: 500 },
    }, { cancelled: false })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'The request contains unsupported parameters for this command.',
    });
  });


  it('connects a fresh install automatically while preserving explicit disconnect', async () => {
    const { background } = await loadBackground();

    expect(background.connectionEnabledFromStored(undefined)).toBe(true);
    expect(background.connectionEnabledFromStored(true)).toBe(true);
    expect(background.connectionEnabledFromStored(false)).toBe(false);
  });

  it('does not connect when the persisted disconnect preference cannot be read', async () => {
    const { browserStub, backgroundReady } = await loadBackground(true);
    await backgroundReady;

    expect(browserStub.runtime.connectNative).not.toHaveBeenCalled();
  });

  it('resumes through the local CLI only after persisted takeover state clears', async () => {
    const { background } = await loadBackground();

    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'pause',
      command: 'takeover.prompt',
    }, { cancelled: false })).resolves.toMatchObject({ requested: true });

    const remove = vi.spyOn(browser.storage.session, 'remove').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'failed-resume',
      command: 'takeover.resume',
    }, { cancelled: false })).rejects.toMatchObject({ code: 'takeover_resume_failed' });
    remove.mockRestore();

    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'resume',
      command: 'takeover.resume',
    }, { cancelled: false })).resolves.toMatchObject({ resumed: true, takeover_requested: false });
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

  it('interrupts a single slow command when cancellation is requested', async () => {
    const { background, browserStub } = await loadBackground();
    const state = { cancelled: false, deadlineAt: Date.now() + 45_000 };
    let release!: () => void;
    browserStub.tabs.query.mockReturnValueOnce(new Promise<chrome.tabs.Tab[]>((resolve) => {
      release = () => resolve([]);
    }));
    const pending = background.dispatchWithinDeadline({
      version: 1,
      kind: 'request',
      request_id: 'slow-list',
      command: 'tabs.list',
    }, state);
    await Promise.resolve();

    background.markCancelled(state);

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    release();
  });
});
