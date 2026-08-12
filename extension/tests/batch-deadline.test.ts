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
    storage: { local: storageArea({}), session: storageArea({}) },
    permissions: { contains: async () => true },
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
});
