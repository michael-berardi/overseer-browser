import { runInIsolatedWorld, type RectResult } from './automation';
import { isBoundedNativeFrame } from './protocol';

export const MAX_SCREENSHOT_FRAME_BYTES = 850 * 1024;
const JPEG_QUALITIES = [0.78, 0.62, 0.48, 0.34, 0.24];
const SCALE_FACTORS = [1, 0.8, 0.64, 0.5, 0.4];

export type ScreenshotFormat = 'jpeg' | 'png';

export interface ScreenshotResult {
  format: ScreenshotFormat;
  data: string;
  bytes: number;
  width: number;
  height: number;
  cropped: boolean;
}

export async function requireActiveScreenshotTarget(tabId: number, windowId: number): Promise<void> {
  const [activeTab] = await browser.tabs.query({ windowId, active: true });
  if (activeTab?.id !== tabId) {
    throw new ScreenshotError('screenshot_target_not_active', 'The requested tab is not active in its window.', 'Select the requested tab before capturing a screenshot.');
  }
}

export async function captureScreenshot(
  tabId: number,
  windowId: number,
  rect?: RectResult,
  format: ScreenshotFormat = 'jpeg',
): Promise<ScreenshotResult> {
  if (format !== 'jpeg' && format !== 'png') {
    throw new ScreenshotError('screenshot_format', 'Screenshot format must be jpeg or png.');
  }
  await requireActiveScreenshotTarget(tabId, windowId);
  const captureOptions = format === 'jpeg' ? { format: 'jpeg' as const, quality: 82 } : { format: 'png' as const };
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, captureOptions);
  } catch (error) {
    // Chrome accepts only '<all_urls>' (or an activeTab gesture) for
    // captureVisibleTab; scoped per-origin and legacy wildcard grants do not
    // cover it. Unlimited grants issued before 0.2.0 predate '<all_urls>'.
    if (error instanceof Error && error.message.includes("'<all_urls>'")) {
      throw new ScreenshotError(
        'screenshot_permission_required',
        'Chrome blocks tab capture without an <all_urls> grant.',
        'Enable unlimited access in the popup; if it is already on, toggle it off and on once to upgrade the grant.',
      );
    }
    throw error;
  }
  // Validate the capture payload before touching the page; the bitmap decode
  // and the viewport probe are independent and run together.
  const captured = captureDataUrlToBlob(dataUrl);
  const [source, viewport] = await Promise.all([
    createImageBitmap(captured),
    runInIsolatedWorld(tabId, { kind: 'viewport' }) as Promise<{ width: number; height: number; devicePixelRatio: number }>,
  ]);
  try {
    const crop = rect ? calculateCrop(rect, viewport, source.width, source.height) : { left: 0, top: 0, width: source.width, height: source.height };
    for (const scale of SCALE_FACTORS) {
      const targetWidth = Math.max(1, Math.round(crop.width * scale));
      const targetHeight = Math.max(1, Math.round(crop.height * scale));
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, targetWidth, targetHeight);
      const qualities = format === 'jpeg' ? JPEG_QUALITIES : [undefined];
      for (const quality of qualities) {
        const blob = await canvas.convertToBlob(
          format === 'jpeg' ? { type: 'image/jpeg', quality } : { type: 'image/png' },
        );
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const encoded = bytesToBase64(bytes);
        const result: ScreenshotResult = {
          format,
          data: encoded,
          bytes: bytes.byteLength,
          width: targetWidth,
          height: targetHeight,
          cropped: Boolean(rect),
        };
        if (serializedSize(result) <= MAX_SCREENSHOT_FRAME_BYTES && isBoundedNativeFrame(result)) return result;
      }
    }
  } finally {
    source.close();
  }
  throw new ScreenshotError('screenshot_too_large', 'Screenshot could not be compressed below the native frame limit.', 'Resize the Agent Window or request a smaller element screenshot.');
}

export function calculateCrop(rect: RectResult, viewport: { width: number; height: number }, imageWidth: number, imageHeight: number): RectResult {
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
      rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    throw new ScreenshotError('screenshot_target_not_visible', 'The requested element does not have a visible rectangle.', 'Scroll the requested element into view and retry.');
  }
  const right = Math.min(rect.left + rect.width, viewport.width);
  const bottom = Math.min(rect.top + rect.height, viewport.height);
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  if (right <= left || bottom <= top) {
    throw new ScreenshotError('screenshot_target_not_visible', 'The requested element does not intersect the viewport.', 'Scroll the requested element into view and retry.');
  }
  const scaleX = imageWidth / viewport.width;
  const scaleY = imageHeight / viewport.height;
  const cropLeft = Math.max(0, Math.min(imageWidth - 1, Math.round(left * scaleX)));
  const cropTop = Math.max(0, Math.min(imageHeight - 1, Math.round(top * scaleY)));
  const cropRight = Math.max(cropLeft + 1, Math.min(imageWidth, Math.round(right * scaleX)));
  const cropBottom = Math.max(cropTop + 1, Math.min(imageHeight, Math.round(bottom * scaleY)));
  return { left: cropLeft, top: cropTop, width: cropRight - cropLeft, height: cropBottom - cropTop };
}

function captureDataUrlToBlob(dataUrl: string): Blob {
  const separator = dataUrl.indexOf(',');
  const metadata = separator >= 0 ? dataUrl.slice(0, separator) : '';
  if (metadata !== 'data:image/png;base64' && metadata !== 'data:image/jpeg;base64') {
    throw new ScreenshotError('screenshot_capture_failed', 'Chrome returned an invalid screenshot data URL.');
  }
  try {
    const binary = atob(dataUrl.slice(separator + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: metadata === 'data:image/png;base64' ? 'image/png' : 'image/jpeg' });
  } catch {
    throw new ScreenshotError('screenshot_capture_failed', 'Chrome returned an invalid base64 screenshot payload.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class ScreenshotError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'ScreenshotError';
  }
}
