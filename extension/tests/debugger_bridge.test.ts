import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DebuggerBridge, redactDebuggerEvent, trustedDebuggerPopup } from '../src/debugger_bridge';
const event = () => ({ addListener: vi.fn() });
let api: any;
let bridge: DebuggerBridge;
beforeEach(() => {
  vi.useFakeTimers();
  api = { runtime: { id: 'ext', getURL: (p: string) => `chrome-extension://ext/${p}` },
    tabs: { get: vi.fn(async () => ({ url: 'https://example.com/a' })), onUpdated: event(), onRemoved: event() },
    scripting: { executeScript: vi.fn(async () => [{ result: true }]) },
    permissions: { contains: vi.fn(async () => true), onRemoved: event() },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } })), getTargets: vi.fn(async () => [{ tabId: 1, type: 'page', attached: false }]), onDetach: event(), onEvent: event() } };
  vi.stubGlobal('chrome', api);
  bridge = new DebuggerBridge(async (s, id) => s === 'one' && [1, 2].includes(id), true);
  bridge.listen();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const grant = () => bridge.authorize('one', 1, 'https://example.com');
describe('optional debugger boundary', () => {
  it('denies by default, peers and other owned tabs; status does not attach', async () => {
    expect((await bridge.status('one', 1)).authorized).toBe(false);
    await grant();
    await expect(bridge.command('one', 2, 'debugger.input', { op: 'text', text: 'hi' })).rejects.toThrow();
    await expect(bridge.command('peer', 1, 'debugger.input', { op: 'text', text: 'hi' })).rejects.toThrow();
    expect(api.debugger.attach).not.toHaveBeenCalled();
  });
  it('permission alone is not consent and fresh worker restores no grants', async () => {
    await grant();
    expect((await new DebuggerBridge(async () => true).status('one', 1)).authorized).toBe(false);
  });
  it('accepts only the exact popup sender', () => {
    expect(trustedDebuggerPopup({ id: 'ext', url: 'chrome-extension://ext/popup.html' })).toBe(true);
    expect(trustedDebuggerPopup({ id: 'ext', url: 'https://example.com' })).toBe(false);
    expect(trustedDebuggerPopup({ id: 'other', url: 'chrome-extension://ext/popup.html' })).toBe(false);
  });
  it('validates bounded input and forbids raw CDP', async () => {
    await grant();
    for (const p of [{ op: 'click', x: -1, y: 2 }, { op: 'text', text: 'x'.repeat(4097) }, { op: 'key', key: 'F12' }, { op: 'text', text: 'hi', method: 'Runtime.evaluate' }]) await expect(bridge.command('one', 1, 'debugger.input', p)).rejects.toThrow();
    expect(api.debugger.attach).not.toHaveBeenCalled();
  });
  it('dispatches fixed input and revokes navigation', async () => {
    await grant(); await bridge.command('one', 1, 'debugger.input', { op: 'click', x: 2, y: 3 });
    expect(api.debugger.sendCommand.mock.calls.map((c: any[]) => c[1])).toEqual(['Page.getLayoutMetrics', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    api.tabs.onUpdated.addListener.mock.calls[0][0](1, { status: 'loading' });
    await bridge.revoke(1);
    expect(api.debugger.detach).toHaveBeenCalled();
    await expect(bridge.command('one', 1, 'debugger.input', { op: 'key', key: 'Enter' })).rejects.toThrow();
  });
  it('never detaches an existing DevTools attachment', async () => {
    await grant(); api.debugger.getTargets.mockResolvedValue([{ tabId: 1, type: 'page', attached: true }]);
    await expect(bridge.command('one', 1, 'debugger.input', { op: 'key', key: 'Enter' })).rejects.toThrow();
    expect(api.debugger.detach).not.toHaveBeenCalled();
  });
  it('cleans up a late attach after revocation', async () => {
    await grant(); let release!: () => void;
    api.debugger.attach.mockImplementation(() => new Promise<void>(r => { release = r; }));
    const work = bridge.command('one', 1, 'debugger.network', { action: 'start' });
    const rejected = expect(work).rejects.toThrow();
    for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
    const revoke = bridge.revoke(1); release(); await rejected; await revoke;
    expect(api.debugger.detach).toHaveBeenCalledTimes(1);
    expect(api.debugger.sendCommand).not.toHaveBeenCalled();
  });
  it('rejects permission denial, origin drift and out-of-viewport dispatch', async () => {
    api.permissions.contains.mockResolvedValue(false);
    await expect(grant()).rejects.toThrow();
    api.permissions.contains.mockResolvedValue(true); await grant();
    api.tabs.get.mockResolvedValue({ url: 'https://other.example/' });
    await expect(bridge.command('one', 1, 'debugger.input', { op: 'text', text: 'hello' })).rejects.toThrow();
    api.tabs.get.mockResolvedValue({ url: 'https://example.com/' }); await grant();
    await expect(bridge.command('one', 1, 'debugger.input', { op: 'click', x: 999, y: 3 })).rejects.toThrow();
    expect(api.debugger.sendCommand.mock.calls.some((c: any[]) => c[1].startsWith('Input.'))).toBe(false);
  });
  it('external detach revokes without attempting to detach DevTools', async () => {
    await grant(); await bridge.command('one', 1, 'debugger.network', { action: 'start' });
    api.debugger.onDetach.addListener.mock.calls[0][0]({ tabId: 1 }, 'replaced_with_devtools');
    await bridge.revoke(1);
    expect(api.debugger.detach).not.toHaveBeenCalled();
    expect((await bridge.status('one', 1)).authorized).toBe(false);
  });
  it('permission removal and lease expiry revoke all grants', async () => {
    await grant();
    api.permissions.onRemoved.addListener.mock.calls[0][0]({ permissions: ['debugger'] });
    expect((await bridge.status('one', 1)).authorized).toBe(false);
    await grant(); await vi.advanceTimersByTimeAsync(300001);
    expect((await bridge.status('one', 1)).authorized).toBe(false);
  });
  it('removes secrets, URLs paths, body data and bounds retained events', async () => {
    const params = { requestId: 'r', timestamp: 1, response: { url: 'https://u:pass@example.com/secret?q=token', status: 200, headers: { Authorization: 'secret', 'Set-Cookie': 'token', 'Content-Type': 'secret' }, body: 'secret' } };
    expect(JSON.stringify(redactDebuggerEvent('Network.responseReceived', params))).not.toMatch(/secret|token|pass|Authorization|Set-Cookie/);
    await grant(); await bridge.command('one', 1, 'debugger.network', { action: 'start' });
    for (let i = 0; i < 250; i++) api.debugger.onEvent.addListener.mock.calls[0][0]({ tabId: 1 }, 'Network.responseReceived', params);
    expect((await bridge.command('one', 1, 'debugger.network', { action: 'logs' }) as any).entries).toHaveLength(200);
  });
});
