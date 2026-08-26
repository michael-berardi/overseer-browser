import { describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function event() {
  const listeners = new Set<Listener>();
  return {
    addListener: vi.fn((listener: Listener) => listeners.add(listener)),
    removeListener: vi.fn((listener: Listener) => listeners.delete(listener)),
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

const NODES_A = [{ ref: 'osr-a', tag: 'button', name: 'Save' }];
const NODES_B = [{ ref: 'osr-a', tag: 'button', name: 'Save' }, { ref: 'osr-b', tag: 'div', text: 'new' }];

async function loadBackground() {
  const onUpdated = event();
  const onRemoved = event();
  const tabs = new Map<number, chrome.tabs.Tab>([
    [11, { id: 11, windowId: 10, url: 'https://example.test/form', title: 'Form', active: true, status: 'complete' } as chrome.tabs.Tab],
  ]);
  let pageNodes: unknown[] = NODES_A;
  const executeScript = vi.fn(async (injection: { func: (...args: never[]) => unknown }) => {
    if (injection.func.name === 'isolatedWaitFor') return [{ result: { ok: true, value: { matched: true } } }];
    return [{ result: { ok: true, value: pageNodes } }];
  });
  const userScriptsExecute = vi.fn(async () => [{ result: { ok: true, value: 'evaluated' } }]);
  const browserStub = {
    storage: {
      local: storageArea({
        'overseer.connection.enabled.v1': false,
        'overseer.capability.evaluate.v1': true,
        'overseer.site.unlimited.v2': true,
      }),
      session: storageArea({}),
    },
    tabs: {
      onUpdated,
      onRemoved,
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('tab missing');
        return tab;
      }),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) => query.windowId === 10 ? [...tabs.values()].filter((tab) => tab.windowId === 10) : []),
      create: vi.fn(),
      update: vi.fn(),
    },
    runtime: { onMessage: event(), connectNative: vi.fn(), getURL: (path: string) => path },
    windows: {
      get: async (id: number) => ({ id }),
      create: async () => ({ id: 10, tabs: [{ id: 11, windowId: 10, url: 'about:blank', active: true }] }),
    },
    scripting: { executeScript },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    },
    userScripts: {
      execute: userScriptsExecute,
      getScripts: vi.fn(async () => []),
    },
  };
  vi.stubGlobal('browser', browserStub);
  vi.stubGlobal('chrome', browserStub);
  vi.stubGlobal('defineBackground', (callback: () => void) => callback());
  vi.resetModules();
  const background = await import('../entrypoints/background');
  await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
  return {
    background,
    onUpdated,
    onRemoved,
    tabs,
    executeScript,
    userScriptsExecute,
    setPageNodes: (nodes: unknown[]) => {
      pageNodes = nodes;
    },
    waitFor: (params: Record<string, unknown>) => background.dispatch(
      { version: 1, kind: 'request', request_id: `wait-${crypto.randomUUID()}`, command: 'wait.for', params },
      { cancelled: false },
    ),
  };
}

describe('wait.for dispatch', () => {
  it('resolves an already-matching URL condition without listeners', async () => {
    const { waitFor } = await loadBackground();
    await expect(waitFor({ url_contains: 'example.test' })).resolves.toEqual({ matched: true, url: 'https://example.test/form' });
  });

  it('resolves a ready condition on a complete tab', async () => {
    const { waitFor } = await loadBackground();
    await expect(waitFor({ ready: true })).resolves.toEqual({ matched: true, url: 'https://example.test/form' });
  });

  it('resolves a pending URL condition from a tab update event, not polling', async () => {
    const { waitFor, onUpdated, tabs } = await loadBackground();
    const pending = waitFor({ url_contains: '/done', timeout_ms: 5_000 });
    // Await listener registration itself, not a guessed delay.
    await vi.waitFor(() => expect(onUpdated.addListener.mock.calls.length).toBe(2));
    tabs.set(11, { ...tabs.get(11)!, url: 'https://example.test/done' });
    onUpdated.emit(11, { url: 'https://example.test/done' });
    await expect(pending).resolves.toEqual({ matched: true, url: 'https://example.test/done' });
  });

  it('rejects a pending URL condition when the tab closes', async () => {
    const { waitFor, onRemoved } = await loadBackground();
    const pending = waitFor({ url_contains: '/never', timeout_ms: 5_000 });
    await vi.waitFor(() => expect(onRemoved.addListener.mock.calls.length).toBe(2));
    onRemoved.emit(11);
    await expect(pending).rejects.toMatchObject({ code: 'tab_closed' });
  });

  it('runs page conditions in the tab and returns their bounded result', async () => {
    const { waitFor, executeScript } = await loadBackground();
    await expect(waitFor({ text: 'Saved' })).resolves.toEqual({ matched: true });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: 'ISOLATED' }));
  });

  it('reports an interrupted page wait when the document is replaced mid-wait', async () => {
    const { background, executeScript } = await loadBackground();
    executeScript.mockRejectedValueOnce(new Error('The frame was removed'));
    await expect(background.dispatch(
      { version: 1, kind: 'request', request_id: 'wait-nav', command: 'wait.for', params: { selector: '.result' } },
      { cancelled: false },
    )).rejects.toMatchObject({ code: 'wait_interrupted' });
  });

  it('rejects missing conditions, unknown params, and unowned tabs', async () => {
    const { waitFor } = await loadBackground();
    await expect(waitFor({})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(waitFor({ text: 'x', bogus: 1 })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(waitFor({ text: 'x', tab_id: 99 })).rejects.toMatchObject({ code: 'tab_not_owned' });
  });
});

describe('multi-agent mutation serialization', () => {
  it('serializes concurrent mutations on one tab while reads stay concurrent', async () => {
    const { background, executeScript } = await loadBackground();
    const gates: Array<() => void> = [];
    executeScript.mockImplementation(async (injection: { func: (...args: never[]) => unknown; args?: [{ kind: string }] }) => {
      if (injection.func.name === 'installDialogGuards') return [{ result: true }];
      if (injection.func.name === 'collectDialogGuards') return [{ result: [] }];
      if (injection.func.name === 'isolatedWaitFor') return [{ result: { ok: true, value: { matched: true } } }];
      if (injection.func.name === 'isolatedAutomation' && injection.args?.[0]?.kind !== 'observe') {
        await new Promise<void>((resolve) => gates.push(resolve));
        return [{ result: { ok: true, value: { changed: true } } }];
      }
      return [{ result: { ok: true, value: [] } }];
    });
    const click = (id: string) => background.dispatch(
      { version: 1, kind: 'request', request_id: id, command: 'click', params: { tab_id: 11, ref: 'osr-a' } },
      { cancelled: false },
    );
    const first = click('click-1');
    const second = click('click-2');
    const observe = background.dispatch(
      { version: 1, kind: 'request', request_id: 'obs-concurrent', command: 'observe', params: { tab_id: 11 } },
      { cancelled: false },
    );
    // The read completes without waiting for the queued mutation; the second
    // mutation cannot start until the first resolves.
    await expect(observe).resolves.toEqual([]);
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]!();
    await expect(first).resolves.toEqual({ changed: true });
    await vi.waitFor(() => expect(gates.length).toBe(2));
    gates[1]!();
    await expect(second).resolves.toEqual({ changed: true });
  });

  it('runs a queued mutation even when its predecessor failed', async () => {
    const { background, executeScript } = await loadBackground();
    let failNextAutomation = true;
    executeScript.mockImplementation(async (injection: { func: (...args: never[]) => unknown }) => {
      if (injection.func.name === 'installDialogGuards') return [{ result: true }];
      if (injection.func.name === 'collectDialogGuards') return [{ result: [] }];
      if (injection.func.name === 'isolatedAutomation' && failNextAutomation) {
        failNextAutomation = false;
        return [{ result: { ok: false, error: { code: 'stale_ref', message: 'gone' } } }];
      }
      return [{ result: { ok: true, value: { changed: true } } }];
    });
    const click = (id: string) => background.dispatch(
      { version: 1, kind: 'request', request_id: id, command: 'click', params: { tab_id: 11, ref: 'osr-a' } },
      { cancelled: false },
    );
    await expect(click('click-fail')).rejects.toMatchObject({ code: 'stale_ref' });
    await expect(click('click-after-fail')).resolves.toEqual({ changed: true });
  });

  it('never executes a queued evaluate whose request was cancelled while queued', async () => {
    const { background, executeScript, userScriptsExecute } = await loadBackground();
    const gates: Array<() => void> = [];
    executeScript.mockImplementation(async (injection: { func: (...args: never[]) => unknown; args?: [{ kind: string }] }) => {
      if (injection.func.name === 'installDialogGuards') return [{ result: true }];
      if (injection.func.name === 'collectDialogGuards') return [{ result: [] }];
      if (injection.func.name === 'isolatedAutomation') {
        await new Promise<void>((resolve) => gates.push(resolve));
        return [{ result: { ok: true, value: { changed: true } } }];
      }
      return [{ result: { ok: true, value: 'evaluated' } }];
    });
    const first = background.dispatch(
      { version: 1, kind: 'request', request_id: 'click-hold', command: 'click', params: { tab_id: 11, ref: 'osr-a' } },
      { cancelled: false },
    );
    await vi.waitFor(() => expect(gates.length).toBe(1));
    const cancelledState = { cancelled: false };
    const queued = background.dispatch(
      { version: 1, kind: 'request', request_id: 'eval-queued', command: 'evaluate', params: { tab_id: 11, source: '1' } },
      cancelledState,
    );
    cancelledState.cancelled = true;
    gates[0]!();
    await expect(first).resolves.toEqual({ changed: true });
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(userScriptsExecute).not.toHaveBeenCalled();
  });
});

describe('observe changes dispatch', () => {
  it('returns a baseline delta, then only added refs, then rebaselines after navigation', async () => {
    const { background, onUpdated, tabs, setPageNodes } = await loadBackground();
    const observe = (changes: boolean) => background.dispatch(
      { version: 1, kind: 'request', request_id: `obs-${crypto.randomUUID()}`, command: 'observe', params: { changes } },
      { cancelled: false },
    );
    const baseline = await observe(true) as { baseline: boolean; added: unknown[] };
    expect(baseline.baseline).toBe(true);
    expect(baseline.added).toEqual(NODES_A);
    setPageNodes(NODES_B);
    const delta = await observe(true) as { baseline: boolean; added: unknown[]; changed: unknown[]; removed: string[]; unchanged: number };
    expect(delta.baseline).toBe(false);
    expect(delta.unchanged).toBe(1);
    expect(delta.added).toEqual([NODES_B[1]]);
    expect(delta.changed).toEqual([]);
    expect(delta.removed).toEqual([]);
    tabs.set(11, { ...tabs.get(11)!, url: 'https://example.test/other' });
    onUpdated.emit(11, { url: 'https://example.test/other', status: 'loading' });
    const rebaseline = await observe(true) as { baseline: boolean };
    expect(rebaseline.baseline).toBe(true);
  });

  it('keeps the default observe contract unchanged and rejects changes on snapshot', async () => {
    const { background } = await loadBackground();
    const plain = await background.dispatch(
      { version: 1, kind: 'request', request_id: 'obs-plain', command: 'observe', params: {} },
      { cancelled: false },
    );
    expect(plain).toEqual(NODES_A);
    await expect(background.dispatch(
      { version: 1, kind: 'request', request_id: 'snap-changes', command: 'snapshot', params: { changes: true } },
      { cancelled: false },
    )).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
