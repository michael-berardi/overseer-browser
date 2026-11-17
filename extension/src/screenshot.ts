import { runInIsolatedWorld, type RectResult } from './automation';
import { isBoundedNativeFrame } from './protocol';

export const MAX_SCREENSHOT_FRAME_BYTES = 850 * 1024;
const JPEG_QUALITIES = [0.78, 0.62, 0.48, 0.34, 0.24];
const SCALE_FACTORS = [1, 0.8, 0.64, 0.5, 0.4];
let captureTail: Promise<unknown> = Promise.resolve();
let nextCaptureAt = 0;

/** Chrome limits captureVisibleTab per extension, not per Agent Window. */
function queueCapture<T>(work: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const delay = Math.max(0, nextCaptureAt - Date.now());
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return work();
  };
  const result = captureTail.then(run, run);
  captureTail = result.then(() => undefined, () => undefined);
  return result;
}

export type ScreenshotFormat = 'jpeg' | 'png';

/** How long a capture waits for the tab to prove it painted a new frame. */
export const FRAME_PROBE_WAIT_MS = 500;

/**
 * What the tab itself reports about its frame: whether the document is visible,
 * whether two animation frames were served inside the bounded wait, and which
 * scroll offset the next capture would represent.
 */
export interface ScreenshotFrameState {
  visibility: string;
  painted: boolean;
  scroll: { x: number; y: number };
  frame_at_ms: number;
}

export interface ScreenshotResult {
  format: ScreenshotFormat;
  data: string;
  bytes: number;
  /** Size of the returned image in pixels (after any crop and downscale). */
  width: number;
  height: number;
  cropped: boolean;
  /** The page viewport in CSS pixels and its device pixel ratio when the frame was captured. */
  viewport?: { width: number; height: number; devicePixelRatio: number };
  /** The captured bitmap before cropping or scaling, in device pixels. */
  source?: { width: number; height: number };
  /** The region of the source bitmap that was kept, in source pixels (the whole frame when not cropped). */
  crop?: { left: number; top: number; width: number; height: number };
  /** Returned size divided by crop size (1 = full resolution); smaller when shrunk to fit the frame limit. */
  scale?: number;
  /** JPEG quality used (0..1); absent for PNG. */
  quality?: number;
  /** The verified page state (visibility, paint evidence and scroll offset) this frame was captured at. */
  frame?: ScreenshotFrameState;
}

export async function requireActiveScreenshotTarget(tabId: number, windowId: number): Promise<void> {
  const [activeTab] = await browser.tabs.query({ windowId, active: true });
  if (activeTab?.id !== tabId) {
    throw new ScreenshotError('screenshot_target_not_active', 'The requested tab is not active in its window.', 'Select the requested tab before capturing a screenshot.');
  }
}

/**
 * Serialized into the target tab by chrome.scripting.executeScript; it must stay
 * fully self-contained (no module-scope references). It reports whether the tab
 * actually painted (two animation frames served inside a bounded wait) and which
 * scroll offset that frame belongs to. A `waitMs` of 0 reads the current state
 * without waiting for a new frame: paint evidence is only needed before a capture.
 */
async function isolatedFrameProbe(waitMs: number): Promise<{
  visibility: string;
  painted: boolean;
  scroll: { x: number; y: number };
  frame_at_ms: number;
}> {
  const visibility = document.visibilityState;
  const read = (painted: boolean) => ({
    visibility,
    painted,
    scroll: { x: window.scrollX, y: window.scrollY },
    frame_at_ms: Date.now(),
  });
  // A hidden document serves no animation frames, so it can never have painted.
  if (visibility !== 'visible') return read(false);
  const wait = Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), 500) : 0;
  if (wait === 0) return read(true);
  return await new Promise<ReturnType<typeof read>>((resolve) => {
    let frames = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (painted: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(read(painted));
    };
    timeout = setTimeout(() => finish(false), wait);
    const onFrame = (): void => {
      frames += 1;
      if (frames >= 2) finish(true);
      else if (!settled) requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}

function isFrameState(value: unknown): value is ScreenshotFrameState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.visibility !== 'string' || candidate.visibility.length === 0) return false;
  if (typeof candidate.painted !== 'boolean') return false;
  if (typeof candidate.frame_at_ms !== 'number' || !Number.isFinite(candidate.frame_at_ms)) return false;
  const scroll = candidate.scroll;
  if (!scroll || typeof scroll !== 'object') return false;
  const { x, y } = scroll as Record<string, unknown>;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
}

/** Read the tab's own frame state; `waitMs` of 0 reads the current state without waiting. */
export async function probeScreenshotFrame(tabId: number, waitMs = 0): Promise<ScreenshotFrameState> {
  let injection: chrome.scripting.InjectionResult<unknown> | undefined;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: isolatedFrameProbe,
      args: [waitMs],
    });
  } catch {
    throw new ScreenshotError(
      'screenshot_probe_failed',
      'The tab did not answer the screenshot frame probe.',
      'Wait for the tab to finish loading and retry; a discarded or closed tab cannot report its frame state.',
    );
  }
  const state = injection?.result;
  if (!isFrameState(state)) {
    throw new ScreenshotError(
      'screenshot_probe_failed',
      'The tab returned an invalid screenshot frame probe result.',
      'Reload the tab and retry.',
    );
  }
  return state;
}

function tabNotPaintingError(visibility: string): ScreenshotError {
  return new ScreenshotError(
    'screenshot_tab_not_painting',
    `Chrome would return the last painted frame instead of the current viewport: the tab is not painting (document.visibilityState is "${visibility}").`,
    'Bring the window that contains the tab to the front, or use the managed isolated browser via OVERSEER_BROWSER_CONNECTION=managed, then retry.',
  );
}

export async function captureScreenshot(
  tabId: number,
  windowId: number,
  rect?: RectResult,
  format: ScreenshotFormat = 'jpeg',
  checkCancelled: () => void = () => undefined,
): Promise<ScreenshotResult> {
  if (format !== 'jpeg' && format !== 'png') {
    throw new ScreenshotError('screenshot_format', 'Screenshot format must be jpeg or png.');
  }
  await requireActiveScreenshotTarget(tabId, windowId);
  // captureVisibleTab has no way to report that it re-sent a stale frame: an
  // unoccluded-but-unpainted or hidden tab silently answers with its last
  // painted pixels (usually the top of the page). Prove the tab is painting and
  // pin the scroll offset before spending a capture call on it.
  const frame = await probeScreenshotFrame(tabId, FRAME_PROBE_WAIT_MS);
  if (frame.visibility !== 'visible' || !frame.painted) throw tabNotPaintingError(frame.visibility);
  const captureOptions = format === 'jpeg' ? { format: 'jpeg' as const, quality: 82 } : { format: 'png' as const };
  let dataUrl: string;
  try {
    dataUrl = await captureWithReadbackRetry(tabId, windowId, captureOptions, checkCancelled);
    await requireActiveScreenshotTarget(tabId, windowId);
    checkCancelled();
    // The frame that was just read is only trustworthy if the viewport did not
    // move underneath it; a scroll between the probe and the capture would
    // return pixels that no longer match the page the caller is looking at.
    const settled = await probeScreenshotFrame(tabId, 0);
    if (settled.visibility !== 'visible') throw tabNotPaintingError(settled.visibility);
    if (settled.scroll.x !== frame.scroll.x || settled.scroll.y !== frame.scroll.y) {
      throw new ScreenshotError(
        'screenshot_viewport_changed',
        'The page scrolled while this frame was captured, so the pixels do not match the current viewport.',
        'Wait for the page to settle after the scroll and retry.',
      );
    }
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
    if (isReadbackFailure(error)) {
      throw new ScreenshotError(
        'screenshot_window_occluded',
        'Chrome could not read back a frame from the Agent Window: it is covered or minimized, so Chrome stopped painting it.',
        'Use the isolated agent browser (OVERSEER_BROWSER_CONNECTION=managed), or uncover the Agent Window and retry. Agent Windows are never focused automatically.',
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
          viewport: { width: viewport.width, height: viewport.height, devicePixelRatio: viewport.devicePixelRatio },
          source: { width: source.width, height: source.height },
          crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height },
          frame,
          scale,
          ...(quality === undefined ? {} : { quality }),
        };
        if (serializedSize(result) <= MAX_SCREENSHOT_FRAME_BYTES && isBoundedNativeFrame(result)) return result;
      }
    }
  } finally {
    source.close();
  }
  throw new ScreenshotError('screenshot_too_large', 'Screenshot could not be compressed below the native frame limit.', 'Resize the Agent Window or request a smaller element screenshot.');
}

const READBACK_RETRY_DELAYS_MS = [250, 600];
const QUOTA_RETRY_DELAY_MS = 1100;
const MAX_QUOTA_RETRIES = 3;

export function isReadbackFailure(error: unknown): boolean {
  return error instanceof Error && /image readback failed/i.test(error.message);
}

function isCaptureQuotaFailure(error: unknown): boolean {
  return error instanceof Error && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(error.message);
}

type CaptureOptions = { format?: 'jpeg' | 'png'; quality?: number };

/** Each API attempt, including retries, shares the extension service worker's queue. */
async function captureWithReadbackRetry(tabId: number, windowId: number, options: CaptureOptions, checkCancelled: () => void): Promise<string> {
  let readbackRetries = 0;
  let quotaRetries = 0;
  let readbackError: unknown;
  for (;;) {
    try {
      return await queueCapture(async () => {
        checkCancelled();
        await requireActiveScreenshotTarget(tabId, windowId);
        checkCancelled();
        try {
          return await (chrome.tabs.captureVisibleTab as (windowId: number, options: CaptureOptions) => Promise<string>)(windowId, options);
        } finally {
          // Chrome's budget is shared across windows. Start spacing only after
          // the prior API call has settled, including rejected attempts.
          nextCaptureAt = Date.now() + 550;
        }
      });
    } catch (error) {
      if (isReadbackFailure(error)) {
        readbackError = error;
        const delay = READBACK_RETRY_DELAYS_MS[readbackRetries++];
        if (delay === undefined) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      } else if (isCaptureQuotaFailure(error)) {
        if (quotaRetries++ >= MAX_QUOTA_RETRIES) {
          if (readbackError) throw readbackError;
          throw new ScreenshotError(
            'screenshot_rate_limited',
            'Chrome rate-limited screenshot capture after repeated attempts.',
            'Wait a few seconds and retry; reduce concurrent screenshot or recording requests.',
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, QUOTA_RETRY_DELAY_MS));
      } else {
        throw error;
      }
    }
  }
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
