import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session';

interface FakeChrome {
  /** Frame around the page: title bar height / side borders (0 on macOS sides). */
  frame: { width: number; height: number };
  /** Smallest outer window Chrome allows for the window type under test. */
  min: { width: number; height: number };
  /** Largest outer window the display allows. */
  max: { width: number; height: number };
}

const sessionStore: Record<string, unknown> = {};
let outer = { width: 0, height: 0 };

function installBrowser(chrome: FakeChrome) {
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  const clamp = (width: number, height: number) => ({
    width: Math.min(chrome.max.width, Math.max(chrome.min.width, width)),
    height: Math.min(chrome.max.height, Math.max(chrome.min.height, height)),
  });
  const stub = {
    runtime: { getURL: (path: string) => `chrome-extension://test${path}` },
    storage: {
      session: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in sessionStore).map((key) => [key, structuredClone(sessionStore[key])])),
        set: async (values: Record<string, unknown>) => Object.assign(sessionStore, structuredClone(values)),
        remove: async (key: string) => delete sessionStore[key],
      },
    },
    windows: {
      create: vi.fn(async (details: chrome.windows.CreateData) => {
        outer = clamp(details.width ?? 1200, details.height ?? 900);
        return { id: 10, type: details.type, ...outer, tabs: [{ id: 11, windowId: 10, url: 'about:blank', active: true }] };
      }),
      get: vi.fn(async (id: number) => ({ id, ...outer })),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async (id: number, updates: chrome.windows.UpdateInfo) => {
        outer = clamp(updates.width ?? outer.width, updates.height ?? outer.height);
        return { id, ...outer };
      }),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 11, windowId: 10, url: 'about:blank', active: true }]),
      create: vi.fn(async () => ({ id: 12, windowId: 99 })),
      get: vi.fn(async (id: number) => ({ id, windowId: 10, url: 'about:blank', active: true })),
      update: vi.fn(),
      remove: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { width: outer.width - chrome.frame.width, height: outer.height - chrome.frame.height, devicePixelRatio: 2 } }]),
    },
  };
  vi.stubGlobal('browser', stub);
  return stub;
}

const MAC_POPUP: FakeChrome = { frame: { width: 0, height: 28 }, min: { width: 200, height: 100 }, max: { width: 1800, height: 1000 } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mobile Agent Window', () => {
  it('opens an unfocused popup and reports the viewport the page measures', async () => {
    const stub = installBrowser(MAC_POPUP);
    const started = await new SessionManager().start(undefined, { width: 375, height: 812 });

    expect(stub.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, type: 'popup', width: 375, height: 812, left: 0, top: 0 }));
    expect(started).toMatchObject({ started: true, mobile: { width: 375, height: 812 }, viewport: { width: 375, height: 812, devicePixelRatio: 2 } });
    // The title bar is not page height: one corrective update, never a focus request.
    expect(stub.windows.update).toHaveBeenCalledTimes(1);
    expect(stub.windows.update).toHaveBeenCalledWith(10, { width: 375, height: 840 });
    expect(JSON.stringify(stub.windows.update.mock.calls)).not.toContain('focused');
    expect(sessionStore['overseer.session.v1']).toMatchObject({ mobile: { width: 375, height: 812 } });
  });

  it('reads the placeholder page by message when scripting cannot reach the extension page', async () => {
    const stub = installBrowser(MAC_POPUP);
    stub.scripting.executeScript.mockRejectedValue(new Error('Cannot access contents of url "chrome-extension://test/agent-window.html".'));
    const sendMessage = vi.fn(async (message: { type: string; windowId: number }) =>
      message.type === 'overseer-agent-window-viewport' && message.windowId === 10
        ? { width: outer.width - MAC_POPUP.frame.width, height: outer.height - MAC_POPUP.frame.height, devicePixelRatio: 2 }
        : undefined,
    );
    (stub.runtime as Record<string, unknown>).sendMessage = sendMessage;
    const started = await new SessionManager().start(undefined, { width: 375, height: 812 });

    expect(started).toMatchObject({ started: true, viewport: { width: 375, height: 812, devicePixelRatio: 2 } });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'overseer-agent-window-viewport', windowId: 10 });
  });

  it('compensates for side borders so the page, not the frame, is 375px wide', async () => {
    const stub = installBrowser({ ...MAC_POPUP, frame: { width: 16, height: 39 } });
    const started = await new SessionManager().start(undefined, { width: 375, height: 812 });

    expect(started.viewport).toMatchObject({ width: 375, height: 812 });
    expect(stub.windows.update).toHaveBeenCalledWith(10, { width: 391, height: 851 });
  });

  it('defaults to a 375x812 viewport', async () => {
    const stub = installBrowser(MAC_POPUP);
    const started = await new SessionManager().start(undefined, {} as never);

    expect(stub.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', width: 375, height: 812 }));
    expect(started).toMatchObject({ mobile: { width: 375, height: 812 }, viewport: { width: 375, height: 812 } });
  });

  it('rejects viewports outside the supported range before opening a window', async () => {
    const stub = installBrowser(MAC_POPUP);
    for (const bad of [{ width: 199, height: 812 }, { width: 1001, height: 812 }, { width: 375, height: 199 }, { width: 375, height: 3001 }, { width: 375.5, height: 812 }]) {
      await expect(new SessionManager().start(undefined, bad)).rejects.toMatchObject({ code: 'invalid_mobile_window' });
    }
    expect(stub.windows.create).not.toHaveBeenCalled();
  });

  it('fails with window_size_clamped, closes the window and keeps no session when Chrome stays at 500px', async () => {
    const stub = installBrowser({ ...MAC_POPUP, min: { width: 500, height: 100 } });
    const failure = await new SessionManager().start(undefined, { width: 375, height: 812 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'window_size_clamped' });
    expect((failure as Error).message).toContain('500px');
    expect((failure as Error).message).toContain('requested 375px');
    expect((failure as { fallback: string }).fallback).toContain('500px or wider');
    expect(stub.windows.remove).toHaveBeenCalledWith(10);
    expect(sessionStore['overseer.session.v1']).toBeUndefined();
  });

  it('reports a short display as a smaller viewport height, not as a failure', async () => {
    installBrowser({ ...MAC_POPUP, max: { width: 1800, height: 700 } });
    const started = await new SessionManager().start(undefined, { width: 375, height: 812 });

    expect(started.viewport).toMatchObject({ width: 375, height: 672 });
    expect(started.mobile).toEqual({ width: 375, height: 812 });
  });

  it('closes the window and fails with viewport_unreadable when the page cannot be measured', async () => {
    const stub = installBrowser(MAC_POPUP);
    stub.scripting.executeScript.mockRejectedValue(new Error('Cannot access contents of the page'));
    const failure = new SessionManager().start(undefined, { width: 375, height: 812 }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await failure).toMatchObject({ code: 'viewport_unreadable' });
    expect(stub.windows.remove).toHaveBeenCalledWith(10);
    expect(sessionStore['overseer.session.v1']).toBeUndefined();
  });

  it('keeps the start idempotent for the same viewport and refuses to switch window modes silently', async () => {
    const stub = installBrowser(MAC_POPUP);
    const manager = new SessionManager();
    await manager.start(undefined, { width: 375, height: 812 });
    stub.windows.create.mockClear();

    await expect(manager.start(undefined, { width: 375, height: 812 })).resolves.toMatchObject({ started: false, viewport: { width: 375 } });
    await expect(manager.start()).resolves.toMatchObject({ started: false });
    await expect(manager.start(undefined, { width: 414, height: 896 })).rejects.toMatchObject({ code: 'session_conflict' });
    expect(stub.windows.create).not.toHaveBeenCalled();

    await manager.stop();
    installBrowser(MAC_POPUP);
    const normal = new SessionManager();
    await normal.start();
    await expect(normal.start(undefined, { width: 375, height: 812 })).rejects.toMatchObject({ code: 'session_conflict', message: expect.stringContaining('normal Agent Window') });
  });

  it('does not create tabs, which Chrome would open in another window, and survives a service-worker reload', async () => {
    const stub = installBrowser(MAC_POPUP);
    await new SessionManager().start(undefined, { width: 375, height: 812 });
    const reloaded = new SessionManager();

    await expect(reloaded.createTab('https://example.com/')).rejects.toMatchObject({ code: 'mobile_window_single_tab' });
    expect(stub.tabs.create).not.toHaveBeenCalled();
    await expect(reloaded.start(undefined, { width: 375, height: 812 })).resolves.toMatchObject({ started: false });
  });
});

describe('windows.resize clamping', () => {
  it('errors instead of reporting a clamped 500px window as 375', async () => {
    installBrowser({ frame: { width: 0, height: 28 }, min: { width: 500, height: 100 }, max: { width: 1800, height: 1000 } });
    const manager = new SessionManager();
    await manager.start();

    const failure = await manager.resize({ width: 375, height: 812 }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'window_size_clamped' });
    expect((failure as Error).message).toContain('500x812');
    expect((failure as Error).message).toContain('not the requested 375x812');
    expect((failure as { fallback: string }).fallback).toContain('--mobile');
  });

  it('returns the applied size with the page viewport when Chrome honours the request', async () => {
    installBrowser(MAC_POPUP);
    const manager = new SessionManager();
    await manager.start();

    await expect(manager.resize({ width: 700, height: 900 })).resolves.toMatchObject({ width: 700, height: 900, viewport: { width: 700, height: 872 } });
  });

  it('leaves viewport null rather than failing when the page cannot be measured', async () => {
    const stub = installBrowser(MAC_POPUP);
    const manager = new SessionManager();
    await manager.start();
    stub.scripting.executeScript.mockRejectedValue(new Error('no access'));

    const resized = manager.resize({ width: 700, height: 900 });
    await vi.runAllTimersAsync();
    await expect(resized).resolves.toMatchObject({ width: 700, viewport: null });
  });

  it('does not treat a position-only move as a size change', async () => {
    installBrowser(MAC_POPUP);
    const manager = new SessionManager();
    await manager.start();

    await expect(manager.resize({ left: 10, top: 10 })).resolves.toMatchObject({ viewport: expect.anything() });
  });
});
