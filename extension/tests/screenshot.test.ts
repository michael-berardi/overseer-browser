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
    vi.stubGlobal('OffscreenCanvas', vi.fn(() => canvas));

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
