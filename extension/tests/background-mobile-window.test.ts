import { describe, expect, it, vi } from 'vitest';
import { mockMultiSessionBrowser } from './helpers/multi-session-browser';

async function setup() {
  const fixture = mockMultiSessionBrowser();
  fixture.stub.scripting.executeScript.mockResolvedValue([{ result: { width: 375, height: 812, devicePixelRatio: 2 } }]);
  vi.resetModules();
  const background = await import('../entrypoints/background');
  let sequence = 0;
  const call = (command: string, params: Record<string, unknown> = {}) => background.dispatch(
    { version: 1, kind: 'request', request_id: `request-${++sequence}`, session_key: 'mobile', command, params },
    { cancelled: false },
  );
  return { ...fixture, call };
}

describe('sessions.start mobile window parameters', () => {
  it('opens an unfocused popup at the requested viewport and returns the measured one', async () => {
    const { call, stub } = await setup();

    const started = await call('sessions.start', { mobile: true, width: 375, height: 812 });

    expect(stub.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, type: 'popup', width: 375, height: 812 }));
    expect(started).toMatchObject({ started: true, mobile: { width: 375, height: 812 }, viewport: { width: 375, height: 812, devicePixelRatio: 2 } });
    expect(await call('sessions.list')).toMatchObject([{ sessionKey: 'mobile', mobile: { width: 375, height: 812 } }]);
  });

  it('keeps a plain start a normal, unfocused window', async () => {
    const { call, stub } = await setup();

    await call('sessions.start');

    expect(stub.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, type: 'normal' }));
    expect(stub.windows.create).toHaveBeenCalledWith(expect.not.objectContaining({ width: expect.anything() }));
  });

  it('rejects size without mobile, a non-boolean mobile flag and out-of-range sizes before opening anything', async () => {
    const { call, stub } = await setup();

    await expect(call('sessions.start', { width: 375 })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.start', { mobile: 'yes' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('sessions.start', { mobile: true, width: 100 })).rejects.toMatchObject({ code: 'invalid_mobile_window' });
    await expect(call('sessions.start', { mobile: true, depth: 1 })).rejects.toBeDefined();
    expect(stub.windows.create).not.toHaveBeenCalled();
  });
});
