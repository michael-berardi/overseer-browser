import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureScreenshot } from '../src/screenshot';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Answers the frame freshness probe (one numeric arg) with a visible, painted,
 * unscrolled tab so these tests still exercise capture/readback behaviour; the
 * automation viewport probe keeps its usual envelope.
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

describe('screenshot readback failures', () => {
  it('names an occluded Agent Window after bounded retries instead of a raw operation failure', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => {
      throw new Error('Failed to capture tab: image readback failed');
    });
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab }, scripting: { executeScript: frameProbeInjection() } });

    const pending = captureScreenshot(21, 7);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'screenshot_window_occluded' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(captureVisibleTab).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated capture errors', async () => {
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => {
      throw new Error('Tabs cannot be edited right now');
    });
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab }, scripting: { executeScript: frameProbeInjection() } });

    await expect(captureScreenshot(21, 7)).rejects.toThrow('Tabs cannot be edited right now');
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });
});
