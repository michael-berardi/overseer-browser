import {
  COMMANDS,
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  type Command,
  type MeetingDetection,
  type NativeOutbound,
  type NativeRequest,
  isBoundedNativeFrame,
  isMeetingDetection,
  isNativeHandshakeAck,
  isNativeHostError,
  isNativeMeetingAck,
  parseNativeRequest,
  responseError,
  responseOk,
} from '../src/protocol';
import { AutomationError, runInIsolatedWorld, runPageEvaluation, type AutomationAction } from '../src/automation';
import { getPermissionState, canControlUrl, isNavigableUrl } from '../src/permissions';
import { MeetingDeduper, PendingMeetingQueue } from '../src/meeting';
import { SessionError, SessionManager } from '../src/session';
import { captureScreenshot, requireActiveScreenshotTarget, ScreenshotError } from '../src/screenshot';

const COMMAND_TIMEOUT_MS = 45_000;
const MAX_UPLOAD_CHUNKS = 32;
const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024;
const MEETING_RETRY_MS = 5_000;
const CAPABILITY_STORAGE_KEY = 'overseer.capability.evaluate.v1';
const CONNECTION_STORAGE_KEY = 'overseer.connection.enabled.v1';
const TAKEOVER_STORAGE_KEY = 'overseer.takeover.requested.v1';

interface InflightRequest {
  cancelled: boolean;
}

interface UploadState {
  total: number;
  chunks: Map<number, Uint8Array>;
  bytes: number;
  expiresAt: number;
}

class UploadAssembler {
  private readonly uploads = new Map<string, UploadState>();

  addChunk(params: Record<string, unknown>): { complete: false; received: number; total: number } | { complete: true; contentBase64: string } {
    const uploadId = readString(params, 'upload_id', 128);
    const index = readInteger(params, 'index', 0, MAX_UPLOAD_CHUNKS - 1);
    const total = readInteger(params, 'total', 1, MAX_UPLOAD_CHUNKS);
    const chunk = params.chunk === '' && index === 0 && total === 1
      ? ''
      : readString(params, 'chunk', MAX_UPLOAD_CHUNK_BYTES * 2);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || chunk.length % 4 !== 0) throw new DispatchError('invalid_upload', 'Upload chunks must be base64 encoded.');
    const decoded = decodeBase64(chunk);
    if (decoded.byteLength > MAX_UPLOAD_CHUNK_BYTES) throw new DispatchError('upload_chunk_too_large', 'Upload chunk exceeds the 256 KiB limit.');
    if (index >= total) throw new DispatchError('invalid_upload', 'Upload chunk index is outside total.');
    this.prune();
    let state = this.uploads.get(uploadId);
    if (!state || state.total !== total) {
      state = { total, chunks: new Map(), bytes: 0, expiresAt: Date.now() + 60_000 };
      this.uploads.set(uploadId, state);
    }
    if (!state.chunks.has(index)) {
      state.chunks.set(index, decoded);
      state.bytes += decoded.byteLength;
    }
    if (state.bytes > 8 * 1024 * 1024) {
      this.uploads.delete(uploadId);
      throw new DispatchError('upload_too_large', 'Upload exceeds the 8 MiB limit.');
    }
    if (state.chunks.size !== state.total) return { complete: false, received: state.chunks.size, total: state.total };
    const ordered = [...state.chunks.keys()].sort((a, b) => a - b).map((key) => state?.chunks.get(key) ?? new Uint8Array());
    const bytes = new Uint8Array(state.bytes);
    let offset = 0;
    for (const part of ordered) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    this.uploads.delete(uploadId);
    return { complete: true, contentBase64: encodeBase64(bytes) };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, state] of this.uploads) if (state.expiresAt <= now) this.uploads.delete(key);
  }
}
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

const sessions = new SessionManager();
const deduper = new MeetingDeduper();
const pendingMeetings = new PendingMeetingQueue();
const uploads = new UploadAssembler();
const inflight = new Map<string, InflightRequest>();
let nativeEnabled = false;
let nativePort: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 250;
let meetingRetryTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false;
let lastNativeError: { code: string; message: string; reason?: string; fallback?: string } | null = null;
let evaluateEnabled = false;
let takeoverRequested = false;
const meetingSessionStore = chrome.storage.session;
let meetingStateReady: Promise<void> = Promise.resolve();
let meetingPersistChain: Promise<void> = Promise.resolve();
let backgroundStateReady: Promise<void> = Promise.resolve();

async function restoreBackgroundState(): Promise<void> {
  try {
    const stored = (await browser.storage.local.get([CONNECTION_STORAGE_KEY]))[CONNECTION_STORAGE_KEY];
    nativeEnabled = stored === true;
  } catch {
    nativeEnabled = false;
  }
  try {
    const stored = (await browser.storage.session.get([TAKEOVER_STORAGE_KEY]))[TAKEOVER_STORAGE_KEY];
    takeoverRequested = stored === true;
  } catch {
    takeoverRequested = false;
  }
}

function startBackground(): void {
  meetingStateReady = Promise.allSettled([
    deduper.restore(meetingSessionStore),
    pendingMeetings.restore(meetingSessionStore),
  ]).then(() => undefined);
  backgroundStateReady = restoreBackgroundState();
  void backgroundStateReady.then(() => {
    if (nativeEnabled) connectNative();
  });
  void loadCapability();
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    const value = message as Record<string, unknown>;
    if (value.kind === 'meeting_detected_local') {
      const candidate = value.payload;
      const payload = candidate && typeof candidate === 'object'
        ? {
            version: 1 as const,
            detection_id: (candidate as Record<string, unknown>).detection_id,
            provider: (candidate as Record<string, unknown>).provider,
            meeting_key: (candidate as Record<string, unknown>).meeting_key,
            detected_at_ms: (candidate as Record<string, unknown>).detected_at_ms,
          }
        : candidate;
      if (isMeetingDetection(payload)) {
        void meetingStateReady.then(async () => {
          if (deduper.accept(payload)) {
            pendingMeetings.enqueue(payload);
            await persistMeetingState();
            flushPendingMeetings();
            sendResponse({ ok: true, queued: true });
          } else {
            sendResponse({ ok: true, suppressed: true });
          }
        });
      } else {
        sendResponse({ ok: false, error: 'invalid_detection' });
      }
      return true;
    }
    if (value.kind === 'set_connection' && typeof value.enabled === 'boolean') {
      void setConnectionEnabled(value.enabled)
        .then(() => sendResponse({ enabled: nativeEnabled, connected }))
        .catch(() => sendResponse({ enabled: nativeEnabled, connected }));
      return true;
    }
    if (value.kind === 'popup_state') {
      void popupState().then(sendResponse);
      return true;
    }
    if (value.kind === 'popup_borrow_active') {
      void popupBorrowActive().then(sendResponse);
      return true;
    }
    if (value.kind === 'popup_return_active') {
      void popupReturnActive().then(sendResponse);
      return true;
    }
    if (value.kind === 'set_takeover' && typeof value.enabled === 'boolean') {
      void setTakeoverRequested(value.enabled)
        .then(() => sendResponse({ takeover_requested: takeoverRequested }))
        .catch(() => sendResponse({ takeover_requested: takeoverRequested }));
      return true;
    }
    if (value.kind === 'set_capability' && value.capability === 'evaluate' && typeof value.enabled === 'boolean') {
      evaluateEnabled = value.enabled;
      void browser.storage.local.set({ [CAPABILITY_STORAGE_KEY]: evaluateEnabled }).then(() => sendResponse({ enabled: evaluateEnabled }));
      return true;
    }
    return false;
  });
}

function persistMeetingState(): Promise<void> {
  meetingPersistChain = meetingPersistChain.then(async () => {
    await Promise.all([
      deduper.persist(meetingSessionStore),
      pendingMeetings.persist(meetingSessionStore),
    ]);
  }).catch(() => undefined);
  return meetingPersistChain;
}

async function setConnectionEnabled(enabled: boolean): Promise<void> {
  await backgroundStateReady;
  await browser.storage.local.set({ [CONNECTION_STORAGE_KEY]: enabled });
  nativeEnabled = enabled;
  if (!enabled) {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (meetingRetryTimer !== undefined) {
      clearTimeout(meetingRetryTimer);
      meetingRetryTimer = undefined;
    }
    if (nativePort) nativePort.disconnect();
    nativePort = null;
    connected = false;
    return;
  }
  connectNative();
  flushPendingMeetings();
}

async function setTakeoverRequested(enabled: boolean): Promise<void> {
  if (enabled) {
    takeoverRequested = true;
    try {
      await browser.storage.session.set({ [TAKEOVER_STORAGE_KEY]: true });
    } catch {
      // Keep takeover active in memory if session persistence is temporarily unavailable.
    }
    return;
  }
  try {
    await browser.storage.session.remove(TAKEOVER_STORAGE_KEY);
    takeoverRequested = false;
  } catch {
    // Keep takeover active when clearing persisted state fails.
  }
}

function connectNative(): void {
  if (!nativeEnabled || nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    connected = true;
    port.onMessage.addListener((message: unknown) => {
      if (isNativeHandshakeAck(message)) {
        reconnectDelayMs = resetReconnectDelayOnHandshakeAck(reconnectDelayMs, message);
        lastNativeError = null;
        flushPendingMeetings();
        return;
      }
      if (isNativeMeetingAck(message)) {
        void meetingStateReady.then(async () => {
          pendingMeetings.acknowledge(message.detection_id, message.delivered);
          await persistMeetingState();
          if (pendingMeetings.size > 0) scheduleMeetingRetry();
        });
        return;
      }
      if (isNativeHostError(message)) {
        lastNativeError = message.error;
        connected = false;
        if (nativePort === port) nativePort = null;
        port.disconnect();
        scheduleReconnect();
        return;
      }
      const parsed = parseNativeRequest(message);
      if (!parsed.ok) return;
      void handleRequest(parsed.request);
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      nativePort = null;
      connected = false;
      scheduleReconnect();
    });
    sendNative({ version: 1, kind: 'handshake', extension_id: EXTENSION_ID, capabilities: [...COMMANDS] });
  } catch {
    nativePort = null;
    connected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!nativeEnabled || reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectNative();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
  }, reconnectDelayMs);
}

export function resetReconnectDelayOnHandshakeAck(currentDelayMs: number, message: unknown): number {
  return isNativeHandshakeAck(message) ? 250 : currentDelayMs;
}

function sendNative(message: NativeOutbound): boolean {
  if (!nativeEnabled) return false;
  if (!nativePort) {
    connectNative();
    return false;
  }
  const port = nativePort;
  try {
    if (!isBoundedNativeFrame(message)) {
      if (message.kind === 'response') {
        port.postMessage(responseError(message.request_id, { code: 'response_too_large', message: 'Response exceeds the bounded native frame limit.', fallback: 'Request a smaller snapshot, screenshot, or evaluation result.' }));
        return true;
      }
      return false;
    }
    port.postMessage(message);
    return true;
  } catch {
    port.disconnect();
    return false;
  }

}
function flushPendingMeetings(): void {
  if (!nativeEnabled) return;
  void meetingStateReady.then(async () => {
    if (!nativeEnabled) return;
    const sizeBeforePruning = pendingMeetings.size;
    const payloads = pendingMeetings.values();
    if (pendingMeetings.size !== sizeBeforePruning) await persistMeetingState();
    for (const payload of payloads) {
      if (!sendNative({ version: 1, kind: 'meeting_detected', payload })) break;
    }
    if (pendingMeetings.size > 0) scheduleMeetingRetry();
  });
}
 

function scheduleMeetingRetry(): void {
  if (!nativeEnabled || meetingRetryTimer !== undefined) return;
  meetingRetryTimer = setTimeout(() => {
    meetingRetryTimer = undefined;
    flushPendingMeetings();
  }, MEETING_RETRY_MS);
}

async function handleRequest(request: NativeRequest): Promise<void> {
  const state: InflightRequest = { cancelled: false };
  inflight.set(request.request_id, state);
  try {
    const result = await withTimeout(dispatch(request, state), COMMAND_TIMEOUT_MS);
    if (!state.cancelled) sendNative(responseOk(request.request_id, result));
    else sendNative(responseError(request.request_id, { code: 'cancelled', message: 'Request was cancelled.' }));
  } catch (error) {
    sendNative(responseError(request.request_id, normalizeError(error)));
  } finally {
    inflight.delete(request.request_id);
  }
}

export async function dispatch(request: NativeRequest, state: InflightRequest): Promise<unknown> {
  if (!COMMANDS.includes(request.command as Command)) throw new DispatchError('unsupported_command', `Unsupported command: ${request.command}`, 'Use health.status or help from the CLI.');
  const command = request.command as Command;
  const params = request.params ?? {};
  if (command === 'cancel') {
    const target = readString(params, 'request_id', 128);
    const targetState = inflight.get(target);
    if (!targetState) return { cancelled: false, request_id: target };
    targetState.cancelled = true;
    return { cancelled: true, request_id: target };
  }
  assertNotCancelled(state);
  if (takeoverRequested && isPausedCommand(command)) throw new DispatchError('human_takeover_active', 'Automation is paused for human takeover.', 'Return control to the agent from the extension popup.');
  if (command === 'health.status') return { version: 1, connected, extension_id: EXTENSION_ID, evaluate_enabled: evaluateEnabled, takeover_requested: takeoverRequested, permissions: await getPermissionState(), sessions: await sessions.list() };
  if (command === 'sessions.start') return sessions.start();
  if (command === 'sessions.stop') return sessions.stop();
  if (command === 'sessions.list') return sessions.list();
  if (command === 'windows.resize') return sessions.resize({ width: optionalInteger(params, 'width'), height: optionalInteger(params, 'height'), left: optionalInteger(params, 'left'), top: optionalInteger(params, 'top') });
  if (command === 'tabs.list') return sessions.listTabs();
  if (command === 'tabs.create') return sessions.createTab(optionalString(params, 'url'));
  if (command === 'tabs.select') return sessions.selectTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.close') return sessions.closeTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.borrow') return borrowExistingTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.return') return sessions.returnTab(readInteger(params, 'tab_id', 1));
  if (command === 'navigate') {
    const tabId = await ownedTab(params);
    const url = readString(params, 'url', 4_096);
    if (!isNavigableUrl(url)) throw new DispatchError('invalid_url', 'Only http and https navigation is allowed.');
    if (!(await canControlUrl(url))) throw new DispatchError('permission_required', 'Optional site access is required for this origin.', 'Grant site access from the popup.');
    return browser.tabs.update(tabId, { url });
  }
  if (command === 'back' || command === 'forward' || command === 'reload') {
    const tabId = await targetTab(params);
    if (command === 'back') await browser.tabs.goBack(tabId);
    if (command === 'forward') await browser.tabs.goForward(tabId);
    if (command === 'reload') await browser.tabs.reload(tabId);
    return { tab_id: tabId, command };
  }
  if (command === 'snapshot' || command === 'observe') return runAction(params, { kind: command, maxNodes: optionalInteger(params, 'max_nodes') }, state);
  if (command === 'click' || command === 'hover') return runAction(params, { kind: command, ref: readString(params, 'ref', 128) }, state);
  if (command === 'fill') return runAction(params, { kind: 'fill', ref: readString(params, 'ref', 128), value: readString(params, 'value', 32_000) }, state);
  if (command === 'type') return runAction(params, { kind: 'type', ref: readString(params, 'ref', 128), text: readString(params, 'text', 32_000) }, state);
  if (command === 'select') return runAction(params, { kind: 'select', ref: readString(params, 'ref', 128), value: readString(params, 'value', 2_000) }, state);
  if (command === 'press') return runAction(params, { kind: 'press', ref: optionalString(params, 'ref'), key: readString(params, 'key', 64), code: optionalString(params, 'code') }, state);
  if (command === 'scroll') return runAction(params, { kind: 'scroll', ref: optionalString(params, 'ref'), x: optionalInteger(params, 'x'), y: optionalInteger(params, 'y') }, state);
  if (command === 'evaluate') {
    if (!evaluateEnabled) throw new DispatchError('capability_required', 'Evaluate is disabled. Enable the explicit capability in the popup.', 'Open the popup and enable page evaluation.');
    const tabId = await targetTab(params);
    return runPageEvaluation(tabId, readString(params, 'source', 32_000));
  }
  if (command === 'screenshot.visible' || command === 'screenshot.element') {
    const tabId = await targetTab(params);
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) throw new DispatchError('window_required', 'Target tab is not attached to a window.');
    const rect = command === 'screenshot.element' ? (await runAction(params, { kind: 'element_rect', ref: readString(params, 'ref', 128) }, state) as { left: number; top: number; width: number; height: number }) : undefined;
    await requireActiveScreenshotTarget(tabId, tab.windowId);
    return captureScreenshot(tabId, tab.windowId, rect);
  }
  if (command === 'upload') return runUpload(params, state);
  if (command === 'takeover.prompt') {
    await setTakeoverRequested(true);
    return { requested: true, state: 'human_takeover_required', message: 'Human takeover requested. Automation is paused until the operator returns control.' };
  }
  if (command === 'capture.start') {
    await meetingStateReady;
    deduper.setCaptureActive(true);
    await persistMeetingState();
    return { capture_active: true };
  }
  if (command === 'capture.stop') {
    await meetingStateReady;
    deduper.setCaptureActive(false);
    await persistMeetingState();
    return { capture_active: false };
  }
  throw new DispatchError('unsupported_command', `Unsupported command: ${command}`);
}
function isPausedCommand(command: Command): boolean {
  return command === 'navigate' || command === 'back' || command === 'forward' || command === 'reload' ||
    command === 'snapshot' || command === 'observe' || command === 'click' || command === 'hover' ||
    command === 'fill' || command === 'type' || command === 'select' || command === 'press' ||
    command === 'scroll' || command === 'evaluate' || command === 'screenshot.visible' ||
    command === 'screenshot.element' || command === 'upload';
}

async function ownedTab(params: Record<string, unknown>): Promise<number> {
  const requested = optionalInteger(params, 'tab_id');
  const tabId = requested ?? (await sessions.getSelectedTabId());
  if (!(await sessions.ownsTab(tabId))) throw new DispatchError('tab_not_owned', 'Target tab is not owned or borrowed by the active session.');
  return tabId;
}

export async function borrowExistingTab(tabId: number): Promise<chrome.tabs.Tab> {
  const session = await sessions.requireState();
  const tab = await browser.tabs.get(tabId);
  const existing = session.ownedTabIds.includes(tabId) || session.borrowedTabIds.includes(tabId) || tab.windowId === session.agentWindowId;
  if (!existing) {
    throw new DispatchError('operator_approval_required', 'Borrowing a normal browser tab requires confirmation in the extension popup.', 'Use the popup to borrow the active tab.');
  }
  return sessions.borrowTab(tabId);
}

async function targetTab(params: Record<string, unknown>): Promise<number> {
  const tabId = await ownedTab(params);
  const tab = await browser.tabs.get(tabId);
  if (params.frame_id !== undefined) throw new DispatchError('unsupported_frame', 'Only the top frame is supported by this extension.', 'Use a top-frame ref or a browser fallback for nested frames.');
  if (!tab.url || !(await canControlUrl(tab.url))) throw new DispatchError('permission_required', 'Optional site access is required for this tab.', 'Grant site access from the popup.');
  if (!isNavigableUrl(tab.url)) throw new DispatchError('unsupported_page', 'This page cannot receive isolated automation.', 'Navigate to an http or https page.');
  return tabId;
}

async function runAction(params: Record<string, unknown>, action: AutomationAction, state: InflightRequest): Promise<unknown> {
  const tabId = await targetTab(params);
  assertNotCancelled(state);
  const result = await runInIsolatedWorld(tabId, action);
  assertNotCancelled(state);
  return result;
}

async function runUpload(params: Record<string, unknown>, state: InflightRequest): Promise<unknown> {
  const assembled = uploads.addChunk(params);
  if (!assembled.complete) return assembled;
  const action: AutomationAction = {
    kind: 'upload',
    ref: readString(params, 'ref', 128),
    filename: readString(params, 'filename', 255),
    mimeType: readString(params, 'mime_type', 128),
    contentBase64: assembled.contentBase64,
  };
  return runAction(params, action, state);
}

function popupTabDetails(tab: chrome.tabs.Tab, session?: { ownedTabIds: number[]; borrowedTabIds: number[] }): Record<string, unknown> {
  const tabId = tab.id;
  return {
    id: tabId,
    window_id: tab.windowId,
    url: tab.url,
    title: tab.title,
    owned: tabId !== undefined && session?.ownedTabIds.includes(tabId) === true,
    borrowed: tabId !== undefined && session?.borrowedTabIds.includes(tabId) === true,
  };
}

async function popupState(): Promise<unknown> {
  const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const sessionsState = await sessions.list();
  const session = sessionsState[0];
  return {
    connected,
    native_error: lastNativeError,
    evaluate_enabled: evaluateEnabled,
    takeover_requested: takeoverRequested,
    permissions: await getPermissionState(activeTab?.url),
    sessions: sessionsState,
    active_tab: activeTab ? popupTabDetails(activeTab, session) : null,
  };
}

export async function popupBorrowActive(): Promise<unknown> {
  try {
    const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === undefined) throw new DispatchError('tab_required', 'The active browser tab could not be identified.');
    await sessions.borrowTab(activeTab.id);
    return { ok: true, state: await popupState() };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function popupReturnActive(): Promise<unknown> {
  try {
    const session = await sessions.requireState();
    const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab?.id === undefined) throw new DispatchError('tab_required', 'The active browser tab could not be identified.');
    if (!session.borrowedTabIds.includes(activeTab.id)) {
      throw new DispatchError('tab_not_borrowed', 'The active tab is not borrowed by this session.');
    }
    await sessions.returnTab(activeTab.id);
    return { ok: true, state: await popupState() };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function loadCapability(): Promise<void> {
  const value = (await browser.storage.local.get([CAPABILITY_STORAGE_KEY]))[CAPABILITY_STORAGE_KEY];
  evaluateEnabled = value === true;
}

function assertNotCancelled(state: InflightRequest): void {
  if (state.cancelled) throw new DispatchError('cancelled', 'Request was cancelled.');
}

function normalizeError(error: unknown): { code: string; message: string; reason?: string; fallback?: string } {
  if (error instanceof DispatchError || error instanceof SessionError || error instanceof AutomationError || error instanceof ScreenshotError) {
    return { code: error.code, message: error.message, fallback: error.fallback };
  }
  if (error instanceof Error) return { code: 'operation_failed', message: error.message };
  return { code: 'operation_failed', message: 'The browser operation failed.' };
}

class DispatchError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

function readString(params: Record<string, unknown>, key: string, maxLength: number): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw new DispatchError('invalid_params', `${key} must be a non-empty string of at most ${maxLength} characters.`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 4_096) throw new DispatchError('invalid_params', `${key} must be a string of at most 4096 characters.`);
  return value;
}

function readInteger(params: Record<string, unknown>, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new DispatchError('invalid_params', `${key} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  return readInteger(params, key, -10_000, 10_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new DispatchError('timeout', 'Browser operation exceeded its bounded timeout.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export default defineBackground(() => {
  startBackground();
});