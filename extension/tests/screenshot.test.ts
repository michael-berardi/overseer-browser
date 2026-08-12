import { describe, expect, it, vi } from 'vitest';
import { calculateCrop, captureScreenshot } from '../src/screenshot';

describe('screenshot target selection', () => {
  it('rejects a borrowed tab when another tab is active in its exact window', async () => {
    const query = vi.fn(async () => [{ id: 22, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn();
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({ code: 'screenshot_target_not_active' });
    expect(query).toHaveBeenCalledWith({ windowId: 7, active: true });
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('rejects element rectangles that do not intersect the viewport', () => {
    expect(() => calculateCrop({ left: 900, top: 0, width: 50, height: 50 }, { width: 800, height: 600 }, 1_600, 1_200))
      .toThrowError(expect.objectContaining({ code: 'screenshot_target_not_visible' }));
    expect(calculateCrop({ left: -20, top: 10, width: 40, height: 20 }, { width: 800, height: 600 }, 1_600, 1_200))
      .toEqual({ left: 0, top: 20, width: 40, height: 40 });
  });
});
