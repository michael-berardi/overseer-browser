import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureScreenshot, FRAME_PROBE_WAIT_MS } from '../src/screenshot';
import type { ScreenshotFrameState } from '../src/screenshot';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A JPEG payload that decodes to the page top; the stale frame a hidden tab re-serves. */
const TOP_OF_PAGE_JPEG = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0))}`;

function frame(overrides: Partial<ScreenshotFrameState> = {}): ScreenshotFrameState {
  return { visibility: 'visible', painted: true, scroll: { x: 0, y: 0 }, frame_at_ms: 1_700_000_000_000, ...overrides };
}

/**
 * A scrolled tab (y=1753) whose isolated-world frame probe answers `frames` in
 * call order (the last entry answers any further probe), while the capture API
 * still returns the last painted frame (the top of the page).
 */
function stubScrolledTab(frames: ScreenshotFrameState[]) {
  const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
  const captureVisibleTab = vi.fn(async () => TOP_OF_PAGE_JPEG);
  let probes = 0;
  const executeScript = vi.fn(async (injection: { args?: unknown[] }) => {
    const args = injection.args ?? [];
    if (args.length === 1 && typeof args[0] === 'number') {
      const state = frames[Math.min(probes, frames.length - 1)]!;
      probes += 1;
      return [{ result: state }];
    }
    return [{ result: { ok: true, value: { width: 800, height: 600, devicePixelRatio: 1 } } }];
  });
  vi.stubGlobal('browser', { tabs: { query } });
  vi.stubGlobal('chrome', { tabs: { captureVisibleTab }, scripting: { executeScript } });
  return { query, captureVisibleTab, executeScript };
}

function stubJpegEncoding() {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', vi.fn(function () {
    return {
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      convertToBlob: vi.fn(async () => ({ arrayBuffer: async () => JPEG.buffer })),
    };
  }));
}

describe('screenshot freshness', () => {
  it('rejects a scrolled, non-painting tab instead of returning its stale top-of-page frame', async () => {
    const stale = frame({ visibility: 'hidden', painted: false, scroll: { x: 0, y: 1753 } });
    const { captureVisibleTab, executeScript } = stubScrolledTab([stale]);

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({
      code: 'screenshot_tab_not_painting',
      message: expect.stringContaining('hidden'),
      fallback: expect.stringMatching(/managed/),
    });
    // The stale frame the capture API would have re-served is never requested.
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: 'ISOLATED', args: [FRAME_PROBE_WAIT_MS] }));
  });

  it('returns a verified frame and reports the scroll offset it was captured at', async () => {
    const verified = frame({ scroll: { x: 0, y: 1753 } });
    const { captureVisibleTab, executeScript } = stubScrolledTab([verified, verified]);
    stubJpegEncoding();

    const result = await captureScreenshot(21, 7);

    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    expect(result.frame).toEqual(verified);
    expect(result.frame?.painted).toBe(true);
    expect(result.frame?.visibility).toBe('visible');
    expect(result.frame?.scroll.y).toBe(1753);
    // Pre-capture probe waits for paint; the post-capture probe reads the same scroll without waiting.
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: 'ISOLATED', args: [FRAME_PROBE_WAIT_MS] }));
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: 'ISOLATED', args: [0] }));
  });

  it('rejects a frame whose viewport moved underneath the capture', async () => {
    const before = frame({ scroll: { x: 0, y: 1753 } });
    const after = frame({ scroll: { x: 0, y: 1907 } });
    const { captureVisibleTab } = stubScrolledTab([before, after]);

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({
      code: 'screenshot_viewport_changed',
      message: expect.stringContaining('viewport'),
      fallback: expect.stringContaining('retry'),
    });
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('captures a visible tab that paints on the second bounded probe', async () => {
    const verified = frame({ scroll: { x: 0, y: 1753 } });
    const missed = frame({ painted: false, scroll: verified.scroll });
    const { captureVisibleTab, executeScript } = stubScrolledTab([missed, verified, verified]);
    stubJpegEncoding();

    const result = await captureScreenshot(21, 7);

    const probes = executeScript.mock.calls.flatMap(([{ args }], index) =>
      args?.length === 1 && typeof args[0] === 'number'
        ? [{ wait: args[0], order: executeScript.mock.invocationCallOrder[index]! }]
        : [],
    );
    expect(probes.map(({ wait }) => wait)).toEqual([FRAME_PROBE_WAIT_MS, FRAME_PROBE_WAIT_MS, 0]);
    expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    const captureOrder = captureVisibleTab.mock.invocationCallOrder[0]!;
    expect(captureOrder).toBeGreaterThan(probes[1]!.order);
    expect(captureOrder).toBeLessThan(probes[2]!.order);
    expect(result.frame).toEqual(verified);
  });

  it('gives a busy but visible page a second bounded wait before refusing it', async () => {
    // visibilityState stays "visible" yet no frame is served: a page too busy to paint.
    const busy = frame({ painted: false, scroll: { x: 0, y: 1753 } });
    const { captureVisibleTab, executeScript } = stubScrolledTab([busy]);

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({
      code: 'screenshot_tab_not_painting',
      message: expect.stringContaining('did not paint'),
    });
    expect(captureVisibleTab).not.toHaveBeenCalled();
    // Two bounded waits, not one: only a page that misses both is refused.
    expect(
      executeScript.mock.calls.filter((call) => {
        const args = (call[0] as { args?: unknown[] }).args ?? [];
        return args.length === 1 && args[0] === FRAME_PROBE_WAIT_MS;
      }),
    ).toHaveLength(2);
  });
});
