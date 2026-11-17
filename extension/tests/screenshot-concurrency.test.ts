import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Answers both executeScript injections a capture makes: the frame freshness
 * probe (one numeric wait arg) and the automation viewport probe. These tests
 * never reach the viewport probe, but the frame probe must pass for any capture
 * to be attempted at all.
 */
function frameProbeInjection(viewport = { width: 800, height: 600, devicePixelRatio: 1 }) {
  return vi.fn(async (injection: { args?: unknown[] }) => {
    const args = injection.args ?? [];
    if (args.length === 1 && typeof args[0] === 'number') {
      return [{ result: { visibility: 'visible', painted: true, scroll: { x: 0, y: 0 }, frame_at_ms: 1 } }];
    }
    return [{ result: { ok: true, value: viewport } }];
  });
}

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
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab }, scripting: { executeScript: frameProbeInjection() } });
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

it('spaces retries and other callers from the end of the previous capture', async () => {
  const { captureScreenshot, calls } = await setup();
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab: vi.fn(async (windowId: number) => {
    calls.push({ windowId, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (windowId === 10) throw new Error('image readback failed');
    return 'invalid-image';
  }) }, scripting: { executeScript: frameProbeInjection() } });
  const first = captureScreenshot(11, 10).catch((error) => error.code);
  const second = captureScreenshot(21, 20).catch((error) => error.code);
  await vi.runAllTimersAsync();
  expect(await first).toBe('screenshot_window_occluded');
  expect(await second).toBe('screenshot_capture_failed');
  expect(calls).toHaveLength(4);
  for (let i = 1; i < calls.length; i++) {
    expect(calls[i]!.at - calls[i - 1]!.at - 200).toBeGreaterThanOrEqual(550);
  }
});

it('backs off quota errors and succeeds on a later capture', async () => {
  const { captureScreenshot, calls } = await setup();
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab: vi.fn(async (windowId: number) => {
    calls.push({ windowId, at: Date.now() });
    if (calls.length < 3) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    return 'invalid-image';
  }) }, scripting: { executeScript: frameProbeInjection() } });
  const result = captureScreenshot(11, 10).catch((error) => error.code);
  await vi.runAllTimersAsync();
  expect(await result).toBe('screenshot_capture_failed');
  expect(calls).toHaveLength(3);
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1100);
  expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(1100);
});

it.each([false, true])('reports a persistent quota failure with readback=%s', async (readback) => {
  const { captureScreenshot, calls } = await setup();
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab: vi.fn(async (windowId: number) => {
    calls.push({ windowId, at: Date.now() });
    if (readback && calls.length === 1) throw new Error('image readback failed');
    throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota');
  }) }, scripting: { executeScript: frameProbeInjection() } });
  const result = captureScreenshot(11, 10).catch((error) => error);
  await vi.runAllTimersAsync();
  const error = await result;
  expect(error.code).toBe(readback ? 'screenshot_window_occluded' : 'screenshot_rate_limited');
  expect(error.fallback).toBeTruthy();
  expect(calls).toHaveLength(readback ? 5 : 4);
  const quotaCalls = readback ? calls.slice(1) : calls;
  for (let i = 1; i < quotaCalls.length; i++) {
    expect(quotaCalls[i]!.at - quotaCalls[i - 1]!.at).toBeGreaterThanOrEqual(1100);
  }
});
