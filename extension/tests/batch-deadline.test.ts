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
  const browserStub = {
    storage: {
      local: storageArea({ 'overseer.automation.origins.v1': ['https://example.test/*'] }),
      session: storageArea({}),
    },
    permissions: { contains: vi.fn(async () => true) },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
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
  return { background, browserStub };
}

const batchRequest = {
  version: 1 as const,
  kind: 'request' as const,
  request_id: 'batch',
  command: 'batch',
  params: { actions: [{ command: 'tabs.list' }, { command: 'tabs.list' }] },
};

describe('batch request deadlines', () => {
  it('bounds the active action by the outer deadline and never starts later actions', async () => {
    vi.useFakeTimers();
    const { background, browserStub } = await loadBackground();
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    let releaseFirstAction!: () => void;
    const firstAction = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseFirstAction = resolve; });
    const query = browserStub.tabs.query;
    query.mockReturnValueOnce(firstAction).mockResolvedValue([]);
    const state = { cancelled: false, deadlineAt: Date.now() + 100 };
    const batch = background.dispatch(batchRequest, state);

    await Promise.resolve();
    vi.advanceTimersByTime(100);
    await expect(batch).rejects.toMatchObject({ code: 'timeout' });

    releaseFirstAction();
    expect(query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('propagates cancellation after an action and refuses the next action', async () => {
    vi.useFakeTimers();
    const { background, browserStub } = await loadBackground();
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    let releaseFirstAction!: () => void;
    const firstAction = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseFirstAction = resolve; });
    const query = browserStub.tabs.query;
    query.mockReturnValueOnce(firstAction).mockResolvedValue([]);
    const state = { cancelled: false, deadlineAt: Date.now() + 45_000 };
    const batch = background.dispatch(batchRequest, state);

    await Promise.resolve();
    state.cancelled = true;
    releaseFirstAction();
    await expect(batch).rejects.toMatchObject({ code: 'cancelled' });
    expect(query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('runs bounded read-only actions concurrently across distinct tabs', async () => {
    const { background, browserStub } = await loadBackground();
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    const gates = Array.from(
      { length: 4 },
      () => Promise.withResolvers<chrome.scripting.InjectionResult<unknown>[]>(),
    );
    let started = 0;
    browserStub.scripting.executeScript.mockImplementation(() => {
      const gate = gates[started];
      started += 1;
      return gate.promise;
    });
    const batch = background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'parallel-batch',
      command: 'batch',
      params: {
        stop_on_error: false,
        max_parallel: 4,
        actions: [1_935_869_450, 1_935_869_451, 1_935_869_452, 1_935_869_453].map((tabId) => ({
          command: 'network.read',
          params: { tab_id: tabId, limit: 10 },
        })),
      },
    }, { cancelled: false });
    let earlyFailure: unknown;
    void batch.catch((error: unknown) => {
      earlyFailure = error;
    });
    await vi.waitFor(() => {
      if (earlyFailure) throw earlyFailure;
      expect(started).toBe(4);
    });
    for (const gate of gates) gate.resolve([{ result: [] }]);

    await expect(batch).resolves.toMatchObject({
      completed: 4,
      requested: 4,
      max_parallel: 4,
      results: [
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true },
      ],
    });
  });

  it('rejects unsafe or overlapping parallel batch actions before execution', async () => {
    const { background } = await loadBackground();
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    const state = { cancelled: false };

    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'overlap',
      command: 'batch',
      params: {
        stop_on_error: false,
        max_parallel: 2,
        actions: [
          { command: 'snapshot', params: { tab_id: 7 } },
          { command: 'observe', params: { tab_id: 7 } },
        ],
      },
    }, state)).rejects.toMatchObject({ code: 'invalid_batch_parallel' });
    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'mutation',
      command: 'batch',
      params: {
        stop_on_error: false,
        max_parallel: 2,
        actions: [
          { command: 'click', params: { tab_id: 7, ref: 'osr-button' } },
          { command: 'network.read', params: { tab_id: 8 } },
        ],
      },
    }, state)).rejects.toMatchObject({ code: 'invalid_batch_parallel' });
  });

});
