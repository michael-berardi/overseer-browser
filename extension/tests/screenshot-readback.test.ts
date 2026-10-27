import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureScreenshot } from '../src/screenshot';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('screenshot readback failures', () => {
  it('names an occluded Agent Window after bounded retries instead of a raw operation failure', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => {
      throw new Error('Failed to capture tab: image readback failed');
    });
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });

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
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });

    await expect(captureScreenshot(21, 7)).rejects.toThrow('Tabs cannot be edited right now');
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });
});
