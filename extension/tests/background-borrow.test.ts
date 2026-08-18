import { describe, expect, it, vi } from 'vitest';

function storageArea(store: Record<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: async (key: string) => delete store[key],
  };
}

describe('native tab borrowing approval', () => {
  it('consumes native disconnect errors, rejects arbitrary borrowing, and permits the popup user-gesture path', async () => {
    const localStore: Record<string, unknown> = { 'overseer.connection.enabled.v1': true };
    const sessionStore: Record<string, unknown> = {};
    const tabs = new Map<number, chrome.tabs.Tab>([
      [11, { id: 11, windowId: 10, url: 'about:blank', title: 'Agent', active: true }],
      [99, { id: 99, windowId: 20, url: 'https://example.test/', title: 'Example', active: true }],
    ]);
    let runtimeLastErrorReads = 0;
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const executeScript = vi.fn(async () => [{ result: { installed: true, entries: 0 } }]);
    const browserStub = {
      storage: { local: storageArea(localStore), session: storageArea(sessionStore) },
      permissions: { contains: async () => true },
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
      scripting: { executeScript },
      runtime: {
        onMessage: { addListener: vi.fn() },
        connectNative: () => port,
        getURL: (path: string) => path,
        get lastError() {
          runtimeLastErrorReads += 1;
          return { message: 'Native host has exited.' };
        },
      },
    };
    vi.stubGlobal('browser', browserStub);
    vi.stubGlobal('chrome', browserStub);
    vi.stubGlobal('defineBackground', (callback: () => void) => callback());

    const background = await import('../entrypoints/background');
    await vi.waitFor(() => expect(port.onDisconnect.addListener).toHaveBeenCalledOnce());
    const onDisconnect = port.onDisconnect.addListener.mock.calls[0]?.[0];
    expect(onDisconnect).toBeTypeOf('function');
    onDisconnect?.();
    expect(runtimeLastErrorReads).toBe(1);
    await background.dispatch({ version: 1, kind: 'request', request_id: 'start', command: 'sessions.start' }, { cancelled: false });
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake' })).toBe(4_000);
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake_ack', ok: 'yes' })).toBe(4_000);
    expect(background.resetReconnectDelayOnHandshakeAck(4_000, { version: 1, kind: 'handshake_ack', ok: true })).toBe(250);
    expect(background.classifyNativeHandshake({ version: 1, kind: 'handshake_ack', ok: true })).toEqual({ status: 'accepted' });
    expect(background.classifyNativeHandshake({ version: 1, kind: 'handshake_ack', ok: false, error: 'denied' })).toEqual({
      status: 'rejected',
      message: 'denied',
    });
    expect(background.classifyNativeHandshake({ version: 1, kind: 'handshake_ack' })).toEqual({ status: 'ignored' });
    expect(background.redactNetworkResourceUrl('https://example.test/path?q=secret#fragment')).toBe('https://example.test/path');
    expect(background.redactNetworkResourceUrl('data:text/plain,secret')).toBe('data:[redacted]');
    expect(background.redactNetworkResourceUrl('not a url')).toBe('[invalid-url]');

    const assembler = new background.UploadAssembler();
    expect(() => assembler.addChunk({
      upload_id: 'ordered',
      file_index: 0,
      file_total: 1,
      index: 1,
      total: 2,
      filename: 'notes.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    })).toThrowError(expect.objectContaining({ code: 'invalid_upload_order' }));
    expect(assembler.addChunk({
      upload_id: 'complete',
      file_index: 0,
      file_total: 1,
      index: 0,
      total: 1,
      filename: 'notes.txt',
      mime_type: 'text/plain',
      chunk: 'SGk=',
    })).toMatchObject({
      complete: true,
      files: [{ filename: 'notes.txt', mimeType: 'text/plain', contentBase64: 'SGk=' }],
    });
    for (let index = 0; index < background.MAX_INCOMPLETE_UPLOADS; index += 1) {
      expect(assembler.addChunk({
        upload_id: `pending-${index}`,
        index: 0,
        total: 2,
        filename: `notes-${index}.txt`,
        mime_type: 'text/plain',
        chunk: 'Yg==',
      }, 7, `ref-${index}`)).toMatchObject({ complete: false, received: 1, total: 2 });
    }
    expect(() => assembler.addChunk({
      upload_id: 'over-capacity',
      index: 0,
      total: 2,
      filename: 'overflow.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    }, 7, 'overflow-ref')).toThrowError(expect.objectContaining({
      code: 'upload_capacity_exceeded',
      message: 'Too many incomplete uploads; finish or retry later.',
    }));
    assembler.clear();
    expect(assembler.addChunk({
      upload_id: 'after-clear',
      index: 0,
      total: 2,
      filename: 'clear.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    }, 7, 'clear-ref')).toMatchObject({ complete: false });
    expect(assembler.size).toBe(1);
    expect(assembler.retainedBytes).toBe(1);
    assembler.clear();
    expect(assembler.size).toBe(0);
    expect(assembler.retainedBytes).toBe(0);

    vi.useFakeTimers();
    const expiringAssembler = new background.UploadAssembler(5);
    expiringAssembler.addChunk({
      upload_id: 'expiring',
      index: 0,
      total: 2,
      filename: 'expiring.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    }, 7, 'expiring-ref');
    expect(expiringAssembler.retainedBytes).toBe(1);
    vi.advanceTimersByTime(5);
    expect(expiringAssembler.size).toBe(0);
    expect(expiringAssembler.retainedBytes).toBe(0);
    vi.useRealTimers();

    const contextAssembler = new background.UploadAssembler();
    contextAssembler.addChunk({
      upload_id: 'bound',
      index: 0,
      total: 2,
      filename: 'bound.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    }, 7, 'bound-ref');
    expect(() => contextAssembler.addChunk({
      upload_id: 'bound',
      index: 1,
      total: 2,
      filename: 'bound.txt',
      mime_type: 'text/plain',
      chunk: 'Yg==',
    }, 8, 'bound-ref')).toThrowError(expect.objectContaining({ code: 'upload_context_mismatch' }));


    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'borrow', command: 'tabs.borrow', params: { tab_id: 99 } }, { cancelled: false }))
      .rejects.toMatchObject({ code: 'operator_approval_required' });
    await expect(background.popupBorrowActive()).resolves.toMatchObject({ ok: true });
    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'borrow-again', command: 'tabs.borrow', params: { tab_id: 99 } }, { cancelled: false }))
      .resolves.toMatchObject({ id: 99 });
    await expect(background.dispatch({
      version: 1,
      kind: 'request',
      request_id: 'health',
      command: 'health.status',
    }, { cancelled: false })).resolves.toMatchObject({
      permissions: {
        meetingHosts: true,
        optionalSiteAccess: true,
        currentOrigin: 'https://example.test/*',
        currentOriginAccess: true,
        allSiteAccess: true,
      },
      runtime: {
        inflight_requests: 0,
        incomplete_uploads: 0,
        incomplete_upload_bytes: 0,
      },
    });
    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'console-start', command: 'console.start' }, { cancelled: false }))
      .resolves.toMatchObject({ installed: true });
    await expect(background.dispatch({ version: 1, kind: 'request', request_id: 'return', command: 'tabs.return', params: { tab_id: 99 } }, { cancelled: false }))
      .resolves.toEqual({ returned: true });
    expect(executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 99 },
      world: 'MAIN',
      args: ['console.stop', false, 60_000],
    }));
  });
});
