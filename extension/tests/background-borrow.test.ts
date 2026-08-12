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
    const executeScript = vi.fn(async () => [{ result: { installed: true, entries: 0 } }]);
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
      scripting: { executeScript },
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
    localStore['overseer.automation.origins.v1'] = ['https://example.test/*'];
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
        currentOrigin: 'https://example.test/*',
        currentOriginAccess: true,
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
