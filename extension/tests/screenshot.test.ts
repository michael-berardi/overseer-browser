import { describe, expect, it, vi } from 'vitest';
import { calculateCrop, captureScreenshot, MAX_SCREENSHOT_FRAME_BYTES } from '../src/screenshot';

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
  it.each([
    { format: 'png' as const, mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { format: 'jpeg' as const, mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
  ])('decodes $format capture data URLs without relying on service-worker fetch', async ({ format, mimeType, bytes }) => {
    const encoded = btoa(String.fromCharCode(...bytes));
    const outputBlob = { arrayBuffer: async () => bytes.buffer };
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => `data:${mimeType};base64,${encoded}`);
    const executeScript = vi.fn(async () => [{ result: { ok: true, value: { width: 2, height: 2, devicePixelRatio: 1 } } }]);
    const canvas = {
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      convertToBlob: vi.fn(async (options: { type: string }) => {
        expect(options.type).toBe(mimeType);
        return outputBlob;
      }),
    };
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab }, scripting: { executeScript } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe(mimeType);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      return { width: 2, height: 2, close: vi.fn() };
    }));
    vi.stubGlobal('OffscreenCanvas', vi.fn(function () { return canvas; }));

    const result = await captureScreenshot(21, 7, undefined, format);

    expect(captureVisibleTab).toHaveBeenCalledWith(7, format === 'jpeg' ? { format, quality: 82 } : { format });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.format).toBe(format);
    expect(atob(result.data).slice(0, bytes.length)).toBe(String.fromCharCode(...bytes));
  });

  it.each([
    'data:image/webp;base64,AAAA',
    'data:image/svg+xml;base64,AAAA',
    'data:image/;base64,AAAA',
    'not-a-data-url',
  ])('rejects unsupported capture data URL %s', async (dataUrl) => {
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => dataUrl);
    const createImageBitmap = vi.fn();
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });
    vi.stubGlobal('createImageBitmap', createImageBitmap);

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({ code: 'screenshot_capture_failed' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });


  it('maps Chrome capture permission rejection to an actionable grant error', async () => {
    const query = vi.fn(async () => [{ id: 21, windowId: 7, active: true }]);
    const captureVisibleTab = vi.fn(async () => {
      throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
    });
    vi.stubGlobal('browser', { tabs: { query } });
    vi.stubGlobal('chrome', { tabs: { captureVisibleTab } });

    await expect(captureScreenshot(21, 7)).rejects.toMatchObject({
      code: 'screenshot_permission_required',
      fallback: expect.stringContaining('unlimited'),
    });
  });

  it('rejects element rectangles that do not intersect the viewport', () => {
    expect(() => calculateCrop({ left: 900, top: 0, width: 50, height: 50 }, { width: 800, height: 600 }, 1_600, 1_200))
      .toThrowError(expect.objectContaining({ code: 'screenshot_target_not_visible' }));
    expect(calculateCrop({ left: -20, top: 10, width: 40, height: 20 }, { width: 800, height: 600 }, 1_600, 1_200))
      .toEqual({ left: 0, top: 20, width: 40, height: 40 });
  });
});

describe('screenshot geometry (P-0126)', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  /** A tab whose capture is a `sourceWidth`x`sourceHeight` bitmap; encoded size grows with canvas area. */
  function stubCapture(viewport: { width: number; height: number; devicePixelRatio: number }, sourceWidth: number, sourceHeight: number, bytesPerPixel: number) {
    vi.stubGlobal('browser', { tabs: { query: vi.fn(async () => [{ id: 21, windowId: 7, active: true }]) } });
    vi.stubGlobal('chrome', {
      tabs: { captureVisibleTab: vi.fn(async () => `data:image/jpeg;base64,${btoa(String.fromCharCode(...JPEG))}`) },
      scripting: { executeScript: vi.fn(async () => [{ result: { ok: true, value: viewport } }]) },
    });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: sourceWidth, height: sourceHeight, close: vi.fn() })));
    vi.stubGlobal('OffscreenCanvas', vi.fn(function (this: unknown, width: number, height: number) {
      const size = Math.max(JPEG.length, Math.floor(width * height * bytesPerPixel));
      const bytes = new Uint8Array(size);
      bytes.set(JPEG);
      return { getContext: vi.fn(() => ({ drawImage: vi.fn() })), convertToBlob: vi.fn(async () => ({ arrayBuffer: async () => bytes.buffer })) };
    }));
  }

  it('reports the original 1920 viewport, the 2x bitmap and the scale it was shrunk by to fit the frame limit', async () => {
    stubCapture({ width: 1920, height: 1080, devicePixelRatio: 2 }, 3840, 2160, 0.1);
    const result = await captureScreenshot(21, 7, undefined, 'jpeg');
    expect(result).toMatchObject({
      width: 3072, height: 1728, cropped: false, scale: 0.8, quality: 0.78,
      viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
      source: { width: 3840, height: 2160 },
      crop: { left: 0, top: 0, width: 3840, height: 2160 },
    });
    // The byte cap is unchanged: the returned frame fits it, and the image maps back to the page exactly.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_SCREENSHOT_FRAME_BYTES);
    expect(result.width / result.scale!).toBe(result.crop!.width);
    expect(result.crop!.width / result.viewport!.width).toBe(result.viewport!.devicePixelRatio);
  });

  it('crops a mobile element in device pixels at full scale, clipped to the viewport', async () => {
    stubCapture({ width: 375, height: 812, devicePixelRatio: 3 }, 1125, 2436, 0.01);
    const card = await captureScreenshot(21, 7, { left: 20, top: 100, width: 335, height: 200 }, 'jpeg');
    expect(card).toMatchObject({ cropped: true, scale: 1, width: 1005, height: 600, crop: { left: 60, top: 300, width: 1005, height: 600 },
      viewport: { width: 375, height: 812, devicePixelRatio: 3 }, source: { width: 1125, height: 2436 } });
    const belowFold = await captureScreenshot(21, 7, { left: 0, top: 700, width: 375, height: 300 }, 'jpeg');
    expect(belowFold.crop).toEqual({ left: 0, top: 2100, width: 1125, height: 336 });
  });

  it('keeps the original result fields for existing callers', async () => {
    stubCapture({ width: 800, height: 600, devicePixelRatio: 1 }, 800, 600, 0.01);
    const result = await captureScreenshot(21, 7, undefined, 'png');
    for (const key of ['format', 'data', 'bytes', 'width', 'height', 'cropped']) expect(result).toHaveProperty(key);
    expect(result).not.toHaveProperty('quality'); // PNG has no quality
  });
});
