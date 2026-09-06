import { afterEach, describe, expect, it, vi } from 'vitest';

async function setup() {
  vi.resetModules();
  vi.useFakeTimers();
  const active = new Map([[10, 11], [20, 21]]);
  const calls: Array<{ windowId: number; at: number }> = [];
  const captureVisibleTab = vi.fn(async (windowId: number) => {
    calls.push({ windowId, at: Date.now() });
    return 'invalid-image'; // Stop before bitmap decoding; capture ordering is under test.
  });
  vi.stubGlobal('browser', { tabs: { query: async ({ windowId }: { windowId: number }) => [{ id: active.get(windowId) }] } });
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });
  return { ...(await import('../src/screenshot')), calls, active };
}

afterEach(() => vi.useRealTimers());

describe('parallel Agent Window screenshots', () => {
  it('paces the shared Chrome capture API while keeping each requested window', async () => {
    const { captureScreenshot, calls } = await setup();
    const a = captureScreenshot(11, 10).catch((error) => error.code);
    const b = captureScreenshot(21, 20).catch((error) => error.code);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await a).toBe('screenshot_capture_failed');
    expect(await b).toBe('screenshot_capture_failed');
    expect(calls.map((call) => call.windowId)).toEqual([10, 20]);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(550);
  });

  it('does not capture a queued target after its tab changes or its request is cancelled', async () => {
    const { captureScreenshot, calls, active } = await setup();
    const first = captureScreenshot(11, 10).catch((error) => error.code);
    const changed = captureScreenshot(21, 20).catch((error) => error.code);
    await vi.advanceTimersByTimeAsync(1);
    active.set(20, 22);
    await vi.advanceTimersByTimeAsync(550);
    expect(await first).toBe('screenshot_capture_failed');
    expect(await changed).toBe('screenshot_target_not_active');
    expect(calls).toHaveLength(1);
    const cancelled = captureScreenshot(11, 10, undefined, 'jpeg', () => { throw new Error('cancelled'); }).catch((error) => error.message);
    await vi.advanceTimersByTimeAsync(550);
    expect(await cancelled).toBe('cancelled');
    expect(calls).toHaveLength(1);
  });
});
