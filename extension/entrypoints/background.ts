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
import { AutomationError, runInIsolatedWorld, runPageEvaluation, runWaitFor, type AutomationAction, type SnapshotNode } from '../src/automation';
import { ObserveDeltaStore, computeObserveDelta } from '../src/observe_delta';
import { WaitError, parseWaitTarget } from '../src/wait';
import { getPermissionState, isNavigableUrl, normalizeSiteAccess } from '../src/permissions';
import { MeetingDeduper, PendingMeetingQueue } from '../src/meeting';
import { SessionError, SessionManager } from '../src/session';
import { captureScreenshot, requireActiveScreenshotTarget, ScreenshotError } from '../src/screenshot';
import { browserTelemetry, type BrowserUsageCounter } from '../src/telemetry';

const COMMAND_TIMEOUT_MS = 45_000;
const NATIVE_HANDSHAKE_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_BATCH_ACTIONS = 20;
const MAX_PARALLEL_BATCH_ACTIONS = 8;
const MAX_UPLOAD_FILES = 16;
const MAX_UPLOAD_CHUNKS = 32;
const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MAX_INCOMPLETE_UPLOADS = 8;
export const MAX_INCOMPLETE_UPLOAD_BYTES = 32 * 1024 * 1024;
const UPLOAD_TTL_MS = 60_000;
const MEETING_RETRY_MS = 5_000;
const CONSOLE_LEASE_MS = 60_000;
const CAPABILITY_STORAGE_KEY = 'overseer.capability.evaluate.v1';
const CONNECTION_STORAGE_KEY = 'overseer.connection.enabled.v1';
const NATIVE_RECONNECT_ALARM = 'overseer.native.reconnect.v1';
const TAKEOVER_STORAGE_KEY = 'overseer.takeover.requested.v1';
const BATCHABLE_COMMANDS: ReadonlySet<Command> = new Set([
  'windows.resize', 'tabs.list', 'tabs.create', 'tabs.select', 'tabs.close', 'tabs.return',
  'navigate', 'back', 'forward', 'reload', 'snapshot', 'observe', 'click', 'hover', 'fill',
  'type', 'select', 'press', 'scroll', 'evaluate', 'console.start', 'console.read',
  'console.stop', 'network.read', 'screenshot.visible', 'screenshot.element',
]);
const PARALLEL_BATCH_COMMANDS: ReadonlySet<Command> = new Set([
  'tabs.list', 'snapshot', 'observe', 'network.read',
]);
type TimerHandle = number | NodeJS.Timeout;


interface InflightRequest {
  cancelled: boolean;
  deadlineAt?: number;
  timedOut?: boolean;
  cancelSignal?: Promise<never>;
  cancelSignalReject?: (error: DispatchError) => void;
}
interface NormalizedDispatchError {
  code: string;
  message: string;
  reason?: string;
  fallback?: string;
}

interface BatchAction {
  command: Command;
  params?: Record<string, unknown>;
}

type BatchResult =
  | { ok: true; result: unknown }
  | { ok: false; error: NormalizedDispatchError };


interface UploadFilePayload {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

interface UploadFileState {
  filename: string;
  mimeType: string;
  total: number;
  nextIndex: number;
  chunks: Uint8Array[];
}

interface UploadState {
  tabId: number;
  ref: string;
  fileTotal: number;
  nextFileIndex: number;
  current?: UploadFileState;
  files: UploadFilePayload[];
  bytes: number;
  chunks: number;
  expiresAt: number;
}

export class UploadAssembler {
  private readonly uploads = new Map<string, UploadState>();
  private retainedByteCount = 0;
  private pruneTimer: TimerHandle | undefined;
  constructor(private readonly uploadTtlMs = UPLOAD_TTL_MS) {}


  get size(): number {
    return this.uploads.size;
  }

  get retainedBytes(): number {
    return this.retainedByteCount;
  }
  addChunk(params: Record<string, unknown>, tabId = -1, ref = typeof params.ref === 'string' ? params.ref : ''):
    | { complete: false; received: number; total: number; filesReceived: number; fileTotal: number }
    | { complete: true; files: UploadFilePayload[] } {
    const uploadId = readString(params, 'upload_id', 128);
    const fileIndex = optionalInteger(params, 'file_index') ?? 0;
    const fileTotal = optionalInteger(params, 'file_total') ?? 1;
    if (fileIndex < 0 || fileIndex >= fileTotal || fileTotal < 1 || fileTotal > MAX_UPLOAD_FILES) {
      throw new DispatchError('invalid_upload', `Uploads must contain 1–${MAX_UPLOAD_FILES} files in declared order.`);
    }
    const index = readInteger(params, 'index', 0, MAX_UPLOAD_CHUNKS - 1);
    const total = readInteger(params, 'total', 1, MAX_UPLOAD_CHUNKS);
    const filename = readString(params, 'filename', 255);
    const mimeType = readString(params, 'mime_type', 128);
    const chunk = params.chunk === '' && index === 0 && total === 1
      ? ''
      : readString(params, 'chunk', MAX_UPLOAD_CHUNK_BYTES * 2);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || chunk.length % 4 !== 0) {
      throw new DispatchError('invalid_upload', 'Upload chunks must be base64 encoded.');
    }
    const decoded = decodeBase64(chunk);
    if (decoded.byteLength > MAX_UPLOAD_CHUNK_BYTES) {
      throw new DispatchError('upload_chunk_too_large', 'Upload chunk exceeds the 256 KiB limit.');
    }
    if (index >= total) throw new DispatchError('invalid_upload', 'Upload chunk index is outside total.');
    this.prune();
    let state = this.uploads.get(uploadId);
    if (!state) {
      if (this.uploads.size >= MAX_INCOMPLETE_UPLOADS) {
        throw new DispatchError('upload_capacity_exceeded', 'Too many incomplete uploads; finish or retry later.');
      }
      if (fileIndex !== 0 || index !== 0) {
        throw new DispatchError('invalid_upload_order', 'Upload chunks and files must arrive in declared order.');
      }
      state = {
        tabId,
        ref,
        fileTotal,
        nextFileIndex: 0,
        files: [],
        bytes: 0,
        chunks: 0,
        expiresAt: Date.now() + this.uploadTtlMs,
      };
      this.uploads.set(uploadId, state);
    }
    if (state.tabId !== tabId || state.ref !== ref) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('upload_context_mismatch', 'Upload continuation does not match its original tab and element.');
    }
    if (state.fileTotal !== fileTotal || fileIndex !== state.nextFileIndex) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('invalid_upload_order', 'Upload chunks and files must arrive in declared order.');
    }
    state.current ??= { filename, mimeType, total, nextIndex: 0, chunks: [] };
    const current = state.current;
    if (
      current.filename !== filename ||
      current.mimeType !== mimeType ||
      current.total !== total ||
      current.nextIndex !== index
    ) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('invalid_upload_order', 'Upload chunks and metadata must remain stable and arrive in order.');
    }
    if (this.retainedByteCount + decoded.byteLength > MAX_INCOMPLETE_UPLOAD_BYTES) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('upload_memory_limit', 'Incomplete uploads reached the 32 MiB memory limit; retry after active uploads finish.');
    }
    current.chunks.push(decoded);
    this.retainedByteCount += decoded.byteLength;
    current.nextIndex += 1;
    state.bytes += decoded.byteLength;
    state.chunks += 1;
    state.expiresAt = Date.now() + this.uploadTtlMs;
    this.schedulePrune();
    if (state.bytes > 8 * 1024 * 1024) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('upload_too_large', 'Upload file set exceeds the 8 MiB limit.');
    }
    if (state.chunks > MAX_UPLOAD_CHUNKS) {
      this.deleteUpload(uploadId);
      this.schedulePrune();
      throw new DispatchError('upload_too_many_chunks', `Upload file sets are limited to ${MAX_UPLOAD_CHUNKS} chunks.`);
    }
    if (current.nextIndex < current.total) {
      return {
        complete: false,
        received: current.nextIndex,
        total: current.total,
        filesReceived: state.files.length,
        fileTotal,
      };
    }
    const bytes = new Uint8Array(current.chunks.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of current.chunks) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    state.files.push({ filename, mimeType, contentBase64: encodeBase64(bytes) });
    state.current = undefined;
    state.nextFileIndex += 1;
    if (state.nextFileIndex < state.fileTotal) {
      return {
        complete: false,
        received: 0,
        total: 0,
        filesReceived: state.files.length,
        fileTotal,
      };
    }
    this.deleteUpload(uploadId);
    this.schedulePrune();
    return { complete: true, files: state.files };
  }

  clear(): void {
    this.uploads.clear();
    this.retainedByteCount = 0;
    clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, state] of this.uploads) {
      if (state.expiresAt <= now) this.deleteUpload(key);
    }
    this.schedulePrune();
  }

  private deleteUpload(uploadId: string): void {
    const state = this.uploads.get(uploadId);
    if (!state) return;
    this.retainedByteCount = Math.max(0, this.retainedByteCount - state.bytes);
    this.uploads.delete(uploadId);
  }

  private schedulePrune(): void {
    if (this.pruneTimer !== undefined) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    if (this.uploads.size === 0) return;
    const nextExpiry = Math.min(...[...this.uploads.values()].map((state) => state.expiresAt));
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      this.prune();
    }, Math.max(1, nextExpiry - Date.now()));
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

// Tabs with a live in-page console capture. Restoration only pays for a
// page-world script call when a capture was actually installed; lease expiry
// or navigation may leave a stale entry, which costs one harmless no-op
// cleanup call and is then removed.
const consoleCaptureTabs = new Set<number>();
const sessions = new SessionManager(async (tabId) => {
  if (!consoleCaptureTabs.delete(tabId)) return;
  await restorePageConsole(tabId);
});
const deduper = new MeetingDeduper();
const pendingMeetings = new PendingMeetingQueue();
const uploads = new UploadAssembler();
const observeDeltas = new ObserveDeltaStore();
const tabMutationQueues = new Map<number, Promise<unknown>>();
const MUTATING_ACTION_KINDS: ReadonlySet<string> = new Set([
  'click', 'hover', 'fill', 'type', 'select', 'press', 'scroll', 'element_rect', 'upload',
]);

/**
 * Serialize mutations per tab so concurrent agents driving one browser cannot
 * interleave clicks, fills, and navigations on the same tab. Reads
 * (snapshot/observe/console/network) and waits stay concurrent, and mutations
 * on distinct tabs still run in parallel. Queue entries run even when the
 * predecessor failed, and the entry is dropped once it is the settled tail.
 */
export function enqueueTabMutation<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const tail = tabMutationQueues.get(tabId) ?? Promise.resolve();
  const result = tail.then(work, work);
  tabMutationQueues.set(tabId, result);
  const release = (): void => {
    if (tabMutationQueues.get(tabId) === result) tabMutationQueues.delete(tabId);
  };
  void result.then(release, release);
  return result;
}
const inflight = new Map<string, InflightRequest>();
let nativeEnabled = false;
let nativePort: chrome.runtime.Port | null = null;
let nativeHandshakeTimer: TimerHandle | undefined;
let reconnectTimer: TimerHandle | undefined;
let reconnectDelayMs = 250;
let meetingRetryTimer: TimerHandle | undefined;
let connected = false;
let lastNativeError: { code: string; message: string; reason?: string; fallback?: string } | null = null;
let evaluateEnabled = false;
let takeoverRequested = false;
const meetingSessionStore = chrome.storage.session;
let meetingStateReady: Promise<void> = Promise.resolve();
let meetingPersistChain: Promise<void> = Promise.resolve();
let backgroundStateReady: Promise<void> = Promise.resolve();

const COMMAND_PARAM_KEYS: Record<Command, readonly string[]> = {
  'health.status': [],
  'sessions.start': ['name'],
  'sessions.stop': [],
  'sessions.list': [],
  'windows.resize': ['width', 'height', 'left', 'top'],
  'tabs.list': [],
  'tabs.create': ['url', 'wait_until'],
  'tabs.select': ['tab_id'],
  'tabs.close': ['tab_id'],
  'tabs.borrow': ['tab_id'],
  'tabs.return': ['tab_id'],
  navigate: ['tab_id', 'url', 'wait_until'],
  back: ['tab_id', 'wait_until'],
  forward: ['tab_id', 'wait_until'],
  reload: ['tab_id', 'wait_until'],
  snapshot: ['tab_id', 'max_nodes'],
  observe: ['tab_id', 'max_nodes', 'changes'],
  'wait.for': ['tab_id', 'timeout_ms', 'ready', 'url_contains', 'text', 'absent', 'selector', 'state', 'dom_stable_ms'],
  click: ['tab_id', 'ref'],
  hover: ['tab_id', 'ref'],
  fill: ['tab_id', 'ref', 'value'],
  type: ['tab_id', 'ref', 'text'],
  select: ['tab_id', 'ref', 'value'],
  press: ['tab_id', 'ref', 'key', 'code'],
  scroll: ['tab_id', 'ref', 'x', 'y'],
  evaluate: ['tab_id', 'source'],
  'screenshot.visible': ['tab_id', 'format'],
  'screenshot.element': ['tab_id', 'ref', 'format'],
  upload: ['tab_id', 'ref', 'upload_id', 'index', 'total', 'chunk', 'filename', 'mime_type', 'file_index', 'file_total'],
  batch: ['actions', 'stop_on_error', 'max_parallel'],
  'console.start': ['tab_id', 'clear'],
  'console.read': ['tab_id', 'clear'],
  'console.stop': ['tab_id', 'clear'],
  'network.read': ['tab_id', 'limit'],
  'takeover.prompt': [],
  'takeover.resume': [],
  cancel: ['request_id'],
  'capture.start': [],
  'capture.stop': [],
};

export function assertKnownCommandParams(command: Command, params: Record<string, unknown>): void {
  const allowed = COMMAND_PARAM_KEYS[command];
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new DispatchError('invalid_params', 'The request contains unsupported parameters for this command.');
  }
}

export function connectionEnabledFromStored(stored: unknown): boolean {
  return stored !== false;
}

async function restoreBackgroundState(): Promise<void> {
  try {
    const stored = (await browser.storage.local.get([CONNECTION_STORAGE_KEY]))[CONNECTION_STORAGE_KEY];
    nativeEnabled = connectionEnabledFromStored(stored);
  } catch {
    nativeEnabled = false;
  }
  try {
    const stored = (await browser.storage.session.get([TAKEOVER_STORAGE_KEY]))[TAKEOVER_STORAGE_KEY];
    takeoverRequested = stored === true;
  } catch {
    takeoverRequested = false;
  }
  try {
    await normalizeSiteAccess();
  } catch {
    // Keep the secure default and retry normalization on the next startup.
  }
}

function configureReconnectAlarm(enabled: boolean): void {
  if (!chrome.alarms) return;
  if (enabled) {
    chrome.alarms.create(NATIVE_RECONNECT_ALARM, { periodInMinutes: 1 });
  } else {
    void chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
  }
}

function startBackground(): void {
  meetingStateReady = Promise.allSettled([
    deduper.restore(meetingSessionStore),
    pendingMeetings.restore(meetingSessionStore),
  ]).then(() => undefined);
  backgroundStateReady = restoreBackgroundState();
  void browserTelemetry().maybeSendDaily();
  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === NATIVE_RECONNECT_ALARM) {
        void backgroundStateReady.then(() => {
          if (nativeEnabled && !connected) connectNative();
        });
      }
    });
  }
  chrome.runtime.onStartup?.addListener(() => {
    void browserTelemetry().recordLaunch();
    void backgroundStateReady.then(() => {
      configureReconnectAlarm(nativeEnabled);
      if (nativeEnabled && !connected) connectNative();
    });
  });
  chrome.runtime.onInstalled?.addListener(() => {
    void backgroundStateReady.then(() => {
      configureReconnectAlarm(nativeEnabled);
      if (nativeEnabled && !connected) connectNative();
    });
  });
  void backgroundStateReady.then(() => {
    configureReconnectAlarm(nativeEnabled);
    if (nativeEnabled) connectNative();
  });
  void loadCapability();
  // Observation deltas are per document: a navigation or tab removal
  // invalidates the stored baseline without retaining any page data.
  chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
    if (changeInfo.url !== undefined || changeInfo.status === 'loading') observeDeltas.drop(updatedTabId);
  });
  chrome.tabs.onRemoved.addListener((removedTabId) => {
    observeDeltas.drop(removedTabId);
    consoleCaptureTabs.delete(removedTabId);
  });
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
            void browserTelemetry().recordUsage('meetingsDetected');
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
        .then(() => sendResponse({ enabled: nativeEnabled, native_enabled: nativeEnabled, connected, native_error: lastNativeError }))
        .catch(() => sendResponse({ enabled: nativeEnabled, native_enabled: nativeEnabled, connected, native_error: lastNativeError }));
      return true;
    }
    if (value.kind === 'set_telemetry_consent' && typeof value.enabled === 'boolean') {
      void browserTelemetry().setConsent(value.enabled)
        .then((consent) => sendResponse({ ok: true, telemetry_consent: consent }))
        .catch(() => sendResponse({ ok: false, error: 'telemetry_state_unavailable' }));
      return true;
    }
    if (value.kind === 'telemetry_popup_opened') {
      void browserTelemetry().recordUsage('popupsHandled');
      sendResponse({ ok: true });
      return false;
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
  configureReconnectAlarm(enabled);
  if (!enabled) {
    await cleanupSessionConsoles();
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (nativeHandshakeTimer !== undefined) {
      clearTimeout(nativeHandshakeTimer);
      nativeHandshakeTimer = undefined;
    }
    if (meetingRetryTimer !== undefined) {
      clearTimeout(meetingRetryTimer);
      meetingRetryTimer = undefined;
    }
    if (nativePort) nativePort.disconnect();
    nativePort = null;
    connected = false;
    uploads.clear();
    return;
  }
  connectNative();
}

async function setTakeoverRequested(enabled: boolean): Promise<void> {
  if (enabled) {
    takeoverRequested = true;
    await cleanupSessionConsoles();
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
    connected = false;
    port.onMessage.addListener((message: unknown) => {
      const handshake = classifyNativeHandshake(message);
      if (handshake.status === 'accepted') {
        if (nativePort !== port) return;
        clearNativeHandshakeTimer();
        connected = true;
        reconnectDelayMs = 250;
        lastNativeError = null;
        flushPendingMeetings();
        return;
      }
      if (handshake.status === 'rejected') {
        failNativeConnection(port, {
          code: 'handshake_rejected',
          message: handshake.message,
          fallback: 'Verify the installed native host and extension versions match.',
        });
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
        failNativeConnection(port, message.error);
        return;
      }
      const parsed = parseNativeRequest(message);
      if (!parsed.ok || !connected || nativePort !== port) return;
      void handleRequest(parsed.request);
    });
    port.onDisconnect.addListener(() => {
      const runtimeError = chrome.runtime.lastError;
      if (nativePort !== port) return;
      clearNativeHandshakeTimer();
      nativePort = null;
      connected = false;
      uploads.clear();
      observeDeltas.clear();
      if (runtimeError?.message) {
        lastNativeError = {
          code: 'native_disconnected',
          message: runtimeError.message,
          fallback: 'Reconnect the local host from the extension popup.',
        };
      }
      scheduleReconnect();
    });
    const hello: NativeOutbound = { version: 1, kind: 'handshake', extension_id: EXTENSION_ID, capabilities: [...COMMANDS] };
    if (!isBoundedNativeFrame(hello)) throw new Error('Native handshake exceeds the frame limit.');
    port.postMessage(hello);
    nativeHandshakeTimer = setTimeout(() => {
      if (nativePort === port && !connected) {
        failNativeConnection(port, {
          code: 'handshake_timeout',
          message: 'The native host did not acknowledge the extension handshake.',
          fallback: 'Reconnect the local host from the extension popup.',
        });
      }
    }, NATIVE_HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    nativePort = null;
    connected = false;
    lastNativeError = {
      code: 'native_connect_failed',
      message: error instanceof Error ? error.message : 'The native host connection failed.',
      fallback: 'Verify the local native host is installed, then reconnect from the extension popup.',
    };
    scheduleReconnect();
  }
}
function clearNativeHandshakeTimer(): void {
  if (nativeHandshakeTimer === undefined) return;
  clearTimeout(nativeHandshakeTimer);
  nativeHandshakeTimer = undefined;
}

function failNativeConnection(
  port: chrome.runtime.Port,
  error: { code: string; message: string; reason?: string; fallback?: string },
): void {
  clearNativeHandshakeTimer();
  lastNativeError = error;
  connected = false;
  uploads.clear();
  observeDeltas.clear();
  if (nativePort === port) nativePort = null;
  try {
    port.disconnect();
  } finally {
    scheduleReconnect();
  }
}
export function classifyNativeHandshake(message: unknown):
  | { status: 'accepted' }
  | { status: 'rejected'; message: string }
  | { status: 'ignored' } {
  if (!isNativeHandshakeAck(message)) return { status: 'ignored' };
  if (message.ok) return { status: 'accepted' };
  return { status: 'rejected', message: message.error ?? 'The native host rejected the extension handshake.' };
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
  return classifyNativeHandshake(message).status === 'accepted' ? 250 : currentDelayMs;
}

function sendNative(message: NativeOutbound): boolean {
  if (!nativeEnabled) return false;
  if (!nativePort) {
    connectNative();
    return false;
  }
  if (!connected) return false;
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
    failNativeConnection(port, {
      code: 'native_disconnected',
      message: 'The native host disconnected while sending a message.',
      fallback: 'Reconnect the local host from the extension popup.',
    });
    return false;
  }
}

function flushPendingMeetings(): void {
  if (!nativeEnabled) return;
  if (!connected) {
    connectNative();
    if (pendingMeetings.size > 0) scheduleMeetingRetry();
    return;
  }
  void meetingStateReady.then(async () => {
    if (!nativeEnabled || !connected) return;
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
  const state: InflightRequest = { cancelled: false, deadlineAt: Date.now() + COMMAND_TIMEOUT_MS };
  inflight.set(request.request_id, state);
  try {
    const result = await dispatchWithinDeadline(request, state);
    if (!state.cancelled) sendNative(responseOk(request.request_id, result));
    else sendNative(responseError(request.request_id, { code: 'cancelled', message: 'Request was cancelled.' }));
  } catch (error) {
    sendNative(responseError(request.request_id, normalizeError(error)));
  } finally {
    inflight.delete(request.request_id);
  }
}

function usageCounterForCommand(command: string, result: unknown): BrowserUsageCounter | undefined {
  if (
    command === 'sessions.start'
    && result !== null
    && typeof result === 'object'
    && 'started' in result
    && result.started === true
  ) return 'sessionsStarted';
  if (
    command === 'sessions.stop'
    && result !== null
    && typeof result === 'object'
    && 'stopped' in result
    && result.stopped === true
  ) return 'sessionsEnded';
  if (command === 'tabs.create') return 'tabsOpened';
  if (command === 'tabs.close') return 'tabsClosed';
  if (command === 'navigate' || command === 'back' || command === 'forward' || command === 'reload') {
    return 'navigations';
  }
  if (command === 'screenshot.visible' || command === 'screenshot.element') return 'screenshots';
  return undefined;
}

export async function dispatch(request: NativeRequest, state: InflightRequest): Promise<unknown> {
  const result = await dispatchCommand(request, state);
  const counter = usageCounterForCommand(request.command, result);
  if (counter) void browserTelemetry().recordUsage(counter);
  return result;
}

async function dispatchCommand(request: NativeRequest, state: InflightRequest): Promise<unknown> {
  if (state.deadlineAt === undefined) state.deadlineAt = Date.now() + COMMAND_TIMEOUT_MS;
  if (!COMMANDS.includes(request.command as Command)) throw new DispatchError('unsupported_command', `Unsupported command: ${request.command}`, 'Use health.status or help from the CLI.');
  const command = request.command as Command;
  const params = request.params ?? {};
  assertKnownCommandParams(command, params);
  if (command === 'cancel') {
    const target = readString(params, 'request_id', 128);
    const targetState = inflight.get(target);
    if (!targetState) return { cancelled: false, request_id: target };
    markCancelled(targetState);
    return { cancelled: true, request_id: target };
  }
  assertNotCancelled(state);
  if (takeoverRequested && isPausedCommand(command)) throw new DispatchError('human_takeover_active', 'Automation is paused for human takeover.', 'Run overseer-browser takeover resume to return control to the agent.');
  if (command === 'health.status') {
    const currentUrl = async (): Promise<string | undefined> => {
      try {
        const selectedTabId = await sessions.getSelectedTabId();
        return (await browser.tabs.get(selectedTabId)).url;
      } catch {
        return undefined;
      }
    };
    const [permissions, scriptsAvailable, sessionsState] = await Promise.all([
      currentUrl().then((url) => getPermissionState(url)),
      userScriptsAvailable(),
      sessions.list(),
    ]);
    return {
      version: 1,
      connected,
      extension_version: browser.runtime.getManifest().version,
      extension_id: EXTENSION_ID,
      evaluate_enabled: evaluateEnabled,
      takeover_requested: takeoverRequested,
      permissions,
      user_scripts_available: scriptsAvailable,
      sessions: sessionsState,
      runtime: {
        inflight_requests: Math.max(0, inflight.size - 1),
        incomplete_uploads: uploads.size,
        incomplete_upload_bytes: uploads.retainedBytes,
      },
    };
  }
  if (command === 'sessions.start') return sessions.start(optionalString(params, 'name'));
  if (command === 'sessions.stop') {
    const result = await sessions.stop();
    uploads.clear();
    observeDeltas.clear();
    return result;
  }
  if (command === 'sessions.list') return sessions.list();
  if (command === 'windows.resize') return sessions.resize({ width: optionalInteger(params, 'width'), height: optionalInteger(params, 'height'), left: optionalInteger(params, 'left'), top: optionalInteger(params, 'top') });
  if (command === 'tabs.list') return sessions.listTabs();
  if (command === 'tabs.create') {
    const url = optionalString(params, 'url');
    if (url === undefined) return sessions.createTab();
    if (!isNavigableUrl(url)) throw new DispatchError('invalid_url', 'Only http and https navigation is allowed.');
    const tab = await sessions.createTab();
    if (tab.id === undefined) throw new DispatchError('tab_required', 'Chrome did not return the new tab id.');
    const navigation = await prepareNavigationWait(tab.id, params);
    try {
      await browser.tabs.update(tab.id, { url });
      return await navigation.promise;
    } catch (error) {
      navigation.cancel();
      throw error;
    }
  }
  if (command === 'tabs.select') return sessions.selectTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.close') return sessions.closeTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.borrow') return borrowExistingTab(readInteger(params, 'tab_id', 1));
  if (command === 'tabs.return') {
    const tabId = readInteger(params, 'tab_id', 1);
    const result = await sessions.returnTab(tabId);
    observeDeltas.drop(tabId);
    return result;
  }
  if (command === 'navigate') {
    const tabId = await ownedTab(params);
    const url = readString(params, 'url', 4_096);
    if (!isNavigableUrl(url)) throw new DispatchError('invalid_url', 'Only http and https navigation is allowed.');
    return enqueueTabMutation(tabId, async () => {
      assertNotCancelled(state);
      await sessions.cleanupTab(tabId);
      const navigation = await prepareNavigationWait(tabId, params);
      try {
        await browser.tabs.update(tabId, { url });
        return await navigation.promise;
      } catch (error) {
        navigation.cancel();
        throw error;
      }
    });
  }
  if (command === 'back' || command === 'forward' || command === 'reload') {
    const tabId = await targetTab(params);
    return enqueueTabMutation(tabId, async () => {
      assertNotCancelled(state);
      await sessions.cleanupTab(tabId);
      const navigation = await prepareNavigationWait(tabId, params);
      try {
        if (command === 'reload') {
          await browser.tabs.reload(tabId);
        } else {
          const delta = command === 'back' ? -1 : 1;
          await runHistoryNavigation(tabId, delta);
        }
        return await navigation.promise;
      } catch (error) {
        navigation.cancel();
        throw error;
      }
    });
  }
  if (command === 'snapshot' || command === 'observe') {
    if (params.changes !== undefined && params.changes !== true) throw new DispatchError('invalid_params', 'changes must be true when supplied.');
    if (command === 'observe' && params.changes === true) {
      const tabId = await targetTab(params);
      const nodes = await runAction(params, { kind: 'observe', maxNodes: optionalInteger(params, 'max_nodes') }, state) as SnapshotNode[];
      const { delta, next } = computeObserveDelta(observeDeltas.read(tabId), nodes);
      observeDeltas.write(tabId, next);
      return delta;
    }
    return runAction(params, { kind: command, maxNodes: optionalInteger(params, 'max_nodes') }, state);
  }
  if (command === 'wait.for') {
    const tabId = await targetTab(params);
    const target = parseWaitTarget(params);
    assertNotCancelled(state);
    const remainingMs = state.deadlineAt === undefined ? target.timeoutMs : state.deadlineAt - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    const timeoutMs = Math.min(target.timeoutMs, remainingMs);
    if (target.kind === 'page') {
      const result = await runWaitFor(tabId, target.condition, timeoutMs);
      assertNotCancelled(state);
      return result;
    }
    return waitForTabState(tabId, target, timeoutMs, state);
  }
  if (command === 'click' || command === 'hover') return runAction(params, { kind: command, ref: readString(params, 'ref', 128) }, state);
  if (command === 'fill') return runAction(params, { kind: 'fill', ref: readString(params, 'ref', 128), value: readStringAllowEmpty(params, 'value', 32_000) }, state);
  if (command === 'type') return runAction(params, { kind: 'type', ref: readString(params, 'ref', 128), text: readString(params, 'text', 32_000) }, state);
  if (command === 'select') return runAction(params, { kind: 'select', ref: readString(params, 'ref', 128), value: readString(params, 'value', 2_000) }, state);
  if (command === 'press') return runAction(params, { kind: 'press', ref: optionalString(params, 'ref'), key: readString(params, 'key', 64), code: optionalString(params, 'code') }, state);
  if (command === 'scroll') return runAction(params, { kind: 'scroll', ref: optionalString(params, 'ref'), x: optionalInteger(params, 'x'), y: optionalInteger(params, 'y') }, state);
  if (command === 'evaluate') {
    if (!evaluateEnabled) throw new DispatchError('capability_required', 'Evaluate is disabled. Grant this site or enable unlimited access in the popup.', 'Open the popup and choose the intended access scope.');
    const tabId = await targetTab(params);
    return enqueueTabMutation(tabId, () => {
      assertNotCancelled(state);
      return runPageEvaluation(tabId, readString(params, 'source', 32_000));
    });
  }
  if (command === 'console.start' || command === 'console.read' || command === 'console.stop') {
    const tabId = await targetTab(params);
    const result = await runConsoleCommand(tabId, command, params.clear === true);
    if (command === 'console.start') consoleCaptureTabs.add(tabId);
    if (command === 'console.stop') consoleCaptureTabs.delete(tabId);
    return result;
  }
  if (command === 'network.read') {
    const tabId = await targetTab(params);
    return readNetworkMetadata(tabId, optionalInteger(params, 'limit') ?? 100);
  }
  if (command === 'screenshot.visible' || command === 'screenshot.element') {
    const tabId = await targetTab(params);
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) throw new DispatchError('window_required', 'Target tab is not attached to a window.');
    const requestedFormat = params.format === undefined ? 'jpeg' : readString(params, 'format', 16);
    if (requestedFormat !== 'jpeg' && requestedFormat !== 'png') {
      throw new DispatchError('invalid_params', 'Screenshot format must be jpeg or png.');
    }
    if (command === 'screenshot.element') {
      // element_rect scrolls the page as a side effect; reject non-active
      // targets before touching the page. captureScreenshot re-checks anyway.
      await requireActiveScreenshotTarget(tabId, tab.windowId);
    }
    const rect = command === 'screenshot.element' ? (await runAction(params, { kind: 'element_rect', ref: readString(params, 'ref', 128) }, state) as { left: number; top: number; width: number; height: number }) : undefined;
    return captureScreenshot(tabId, tab.windowId, rect, requestedFormat);
  }
  if (command === 'upload') return runUpload(params, state);
  if (command === 'batch') return runBatch(params, state);
  if (command === 'takeover.prompt') {
    await setTakeoverRequested(true);
    return { requested: true, state: 'human_takeover_required', message: 'Human takeover requested. Automation is paused until the operator returns control.' };
  }
  if (command === 'takeover.resume') {
    await setTakeoverRequested(false);
    if (takeoverRequested) throw new DispatchError('takeover_resume_failed', 'Automation remains paused because takeover state could not be cleared.', 'Retry takeover resume after extension storage is available.');
    return { resumed: true, takeover_requested: false, message: 'Automation resumed by the local operator CLI.' };
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
    command === 'scroll' || command === 'evaluate' || command === 'console.start' ||
    command === 'console.read' || command === 'console.stop' || command === 'network.read' ||
    command === 'screenshot.visible' || command === 'screenshot.element' || command === 'upload' ||
    command === 'batch' || command === 'wait.for';
}

async function ownedTab(params: Record<string, unknown>): Promise<number> {
  const requested = optionalTabId(params);
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
  if (!tab.url || !isNavigableUrl(tab.url)) throw new DispatchError('unsupported_page', 'This page cannot receive isolated automation.', 'Navigate to an http or https page.');
  const permissions = await getPermissionState(tab.url);
  if (!permissions.currentOriginAccess) {
    throw new DispatchError('site_access_required', 'This site has not been granted to OverSeer Browser.', 'Open the popup and grant the current site or enable unlimited access.');
  }
  return tabId;
}

async function runAction(params: Record<string, unknown>, action: AutomationAction, state: InflightRequest): Promise<unknown> {
  const tabId = await targetTab(params);
  assertNotCancelled(state);
  if (!MUTATING_ACTION_KINDS.has(action.kind)) return runInIsolatedWorld(tabId, action);
  return enqueueTabMutation(tabId, async () => {
    assertNotCancelled(state);
    const result = await runInIsolatedWorld(tabId, action);
    assertNotCancelled(state);
    return result;
  });
}

async function runUpload(params: Record<string, unknown>, state: InflightRequest): Promise<unknown> {
  const tabId = await targetTab(params);
  assertNotCancelled(state);
  const ref = readString(params, 'ref', 128);
  const assembled = uploads.addChunk(params, tabId, ref);
  if (!assembled.complete) return assembled;
  return runAction(params, { kind: 'upload', ref, files: assembled.files }, state);
}

interface TabNavigationWait {
  promise: Promise<chrome.tabs.Tab>;
  cancel: () => void;
}

const INTERACTIVE_PROBE_MS = 150;

/**
 * Marks the current document before a navigation is triggered. Interactive
 * probes accept only documents WITHOUT the mark, so a probe can never
 * resolve against the pre-navigation page.
 */
export async function stampNavigationMark(tabId: number, mark: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    injectImmediately: true,
    func: (value: string) => {
      // Without a document element the mark cannot be applied; throwing here
      // degrades the caller to load-wait semantics instead of letting probes
      // resolve against the unmarked pre-navigation page.
      if (!document.documentElement) throw new Error('no document element to mark');
      document.documentElement.setAttribute('data-overseer-nav', value);
    },
    args: [mark],
  });
}

/**
 * Best-effort removal of a navigation mark after a cancelled or failed
 * navigation, so the page does not retain the attribute permanently.
 */
async function clearNavigationMark(tabId: number, mark: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (value: string) => {
        if (document.documentElement?.getAttribute('data-overseer-nav') === value) {
          document.documentElement.removeAttribute('data-overseer-nav');
        }
      },
      args: [mark],
    });
  } catch {
    // The tab may already hold a new document or be gone; residue is cosmetic.
  }
}

/**
 * Resolves as soon as the post-navigation document reports readyState
 * interactive. Probes use immediate injection so they run while the page is
 * still loading; failures mean no committed document yet and are retried
 * until the caller's load-based wait resolves or times out.
 */
export function createTabInteractiveWait(tabId: number, mark: string): TabNavigationWait {
  let settled = false;
  let timer: TimerHandle | undefined;
  let resolveWait: (tab: chrome.tabs.Tab) => void = () => undefined;
  let rejectWait: (error: unknown) => void = () => undefined;
  const promise = new Promise<chrome.tabs.Tab>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const probe = async (): Promise<void> => {
    while (!settled) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          injectImmediately: true,
          func: (value: string) => (
            document.documentElement?.getAttribute('data-overseer-nav') === value ? 'pending' : document.readyState
          ),
          args: [mark],
        });
        if (result?.result === 'interactive' || result?.result === 'complete') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void browser.tabs.get(tabId).then(resolveWait, rejectWait);
          return;
        }
      } catch {
        // No committed document yet, or the probe raced a navigation commit.
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, INTERACTIVE_PROBE_MS);
      });
    }
  };
  void probe();
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Navigation wait honoring `wait_until`: 'load' keeps the historical
 * complete-status semantics; 'interactive' resolves at DOM readiness, but
 * only when the old document was successfully marked first — otherwise the
 * wait degrades to load semantics so a stale document can never satisfy it.
 * The losing arm is always cancelled so no listeners or probes outlive the wait.
 */
export function createNavigationWait(tabId: number, waitUntil: 'load' | 'interactive', mark?: string): TabNavigationWait {
  const loadWait = createTabNavigationWait(tabId);
  if (waitUntil !== 'interactive' || mark === undefined) return loadWait;
  const interactiveWait = createTabInteractiveWait(tabId, mark);
  return {
    promise: Promise.race([loadWait.promise, interactiveWait.promise]).finally(() => {
      loadWait.cancel();
      interactiveWait.cancel();
    }),
    cancel: () => {
      loadWait.cancel();
      interactiveWait.cancel();
    },
  };
}

function readWaitUntil(params: Record<string, unknown>): 'load' | 'interactive' {
  if (params.wait_until === undefined) return 'load';
  const value = readString(params, 'wait_until', 16);
  if (value !== 'load' && value !== 'interactive') {
    throw new DispatchError('invalid_params', 'wait_until must be load or interactive.');
  }
  return value;
}

interface PreparedNavigationWait extends TabNavigationWait {
  mark?: string;
}

/**
 * Builds the navigation wait for a dispatch site. For 'interactive', the
 * current document is marked BEFORE the navigation is triggered; when the
 * mark cannot be applied, the wait degrades to load semantics. The mark is
 * always scrubbed once the wait settles or is cancelled, covering
 * same-document (hash) navigations where the old document survives.
 */
async function prepareNavigationWait(tabId: number, params: Record<string, unknown>): Promise<PreparedNavigationWait> {
  const waitUntil = readWaitUntil(params);
  if (waitUntil !== 'interactive') return createNavigationWait(tabId, waitUntil);
  const mark = crypto.randomUUID();
  try {
    await stampNavigationMark(tabId, mark);
  } catch {
    return createNavigationWait(tabId, 'load');
  }
  const wait = createNavigationWait(tabId, waitUntil, mark);
  const cancel = wait.cancel;
  const scrub = (): void => {
    void clearNavigationMark(tabId, mark);
  };
  return {
    // The inner race cancels both arms before this finally runs, so no probe
    // can resolve from the scrubbed mark afterwards.
    promise: wait.promise.finally(scrub),
    mark,
    cancel: () => {
      cancel();
      scrub();
    },
  };
}

export function createTabNavigationWait(tabId: number): TabNavigationWait {
  let settled = false;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    clearTimeout(timer);
    timer = undefined;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  };
  let resolveWait: (tab: chrome.tabs.Tab) => void = () => undefined;
  let rejectWait: (error: unknown) => void = () => undefined;
  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
    if (updatedTabId !== tabId || settled) return;
    if (changeInfo.status === 'loading') {
      loading = true;
      return;
    }
    // A loading URL event starts a new document. Do not resolve until Chrome
    // reports that document complete, even if a later URL event omits status.
    if (changeInfo.status === 'complete' || (typeof changeInfo.url === 'string' && !loading)) {
      settled = true;
      cleanup();
      void browser.tabs.get(tabId).then(resolveWait, rejectWait);
    }
  };
  const onRemoved = (removedTabId: number): void => {
    if (removedTabId !== tabId || settled) return;
    settled = true;
    cleanup();
    rejectWait(new DispatchError('tab_closed', 'The target tab closed during navigation.'));
  };
  const promise = new Promise<chrome.tabs.Tab>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DispatchError('navigation_timeout', 'The page did not finish navigating before the timeout.', 'Retry after the page settles or use observe to inspect its current state.'));
    }, NAVIGATION_TIMEOUT_MS);
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}
/**
 * Event-driven wait on tab URL or load status. Listeners and timers are
 * released on match, timeout, tab close, or outer request cancellation;
 * `timeoutMs` is pre-capped at the remaining request deadline.
 */
async function waitForTabState(
  tabId: number,
  target: { kind: 'url'; urlContains: string; timeoutMs: number } | { kind: 'ready'; timeoutMs: number },
  timeoutMs: number,
  state: InflightRequest,
): Promise<unknown> {
  const matchesTab = (tab: chrome.tabs.Tab): boolean =>
    target.kind === 'url' ? (tab.url?.includes(target.urlContains) ?? false) : tab.status === 'complete';
  let settled = false;
  let timer: TimerHandle | undefined;
  // Executor form: the shipped tsconfig pins ES2022, before Promise.withResolvers.
  let resolveWait!: (value: unknown) => void;
  let rejectWait!: (error: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolveWait = resolvePromise;
    rejectWait = rejectPromise;
  });
  const cleanup = (): void => {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  };
  const check = (): void => {
    if (settled) return;
    void browser.tabs.get(tabId).then((tab) => {
      if (settled || !matchesTab(tab)) return;
      settled = true;
      cleanup();
      resolveWait({ matched: true, ...(tab.url ? { url: tab.url.slice(0, 2_048) } : {}) });
    }, () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWait(new DispatchError('tab_closed', 'The target tab closed during the wait.'));
    });
  };
  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
    if (updatedTabId !== tabId || settled) return;
    if (changeInfo.url !== undefined || changeInfo.status !== undefined) check();
  };
  const onRemoved = (removedTabId: number): void => {
    if (removedTabId !== tabId || settled) return;
    settled = true;
    cleanup();
    rejectWait(new DispatchError('tab_closed', 'The target tab closed during the wait.'));
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectWait(new WaitError('wait_timeout', 'The wait condition was not met before its timeout.', 'Observe the page to inspect its current state, then retry with a longer timeout_ms.'));
  }, timeoutMs);
  void cancellationSignal(state).catch(() => {
    if (settled) return;
    settled = true;
    cleanup();
  });
  // The initial state check runs only after listeners are attached: a tab
  // update landing between the check and registration can never be missed.
  check();
  return promise;
}

export async function runHistoryNavigation(tabId: number, delta: -1 | 1): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (historyDelta: number) => globalThis.history.go(historyDelta),
      args: [delta],
    });
  } catch {
    const command = delta < 0 ? 'goBack' : 'goForward';
    throw new DispatchError('navigation_unavailable', `Unable to ${command} in this tab's history.`);
  }
}

async function runConsoleCommand(
  tabId: number,
  command: 'console.start' | 'console.read' | 'console.stop',
  clear: boolean,
): Promise<unknown> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (operation: string, shouldClear: boolean, leaseMs: number): unknown => {
      type ConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';
      type ConsoleEntry = { level: ConsoleLevel; timestamp: number; text: string };
      type ConsoleState = {
        entries: ConsoleEntry[];
        originals: Record<ConsoleLevel, (...args: unknown[]) => void>;
        expiresAt: number;
        timer?: ReturnType<typeof setTimeout>;
      };
      const root = globalThis as typeof globalThis & { __overseerConsoleV1?: ConsoleState };
      const levels: ConsoleLevel[] = ['debug', 'info', 'log', 'warn', 'error'];
      const restore = (state: ConsoleState): void => {
        if (root.__overseerConsoleV1 !== state) return;
        clearTimeout(state.timer);
        state.timer = undefined;
        for (const level of levels) console[level] = state.originals[level];
        delete root.__overseerConsoleV1;
      };
      if (operation === 'console.start') {
        const existing = root.__overseerConsoleV1;
        if (existing && existing.expiresAt > Date.now()) return { installed: true, entries: existing.entries.length };
        if (existing) restore(existing);
        const state: ConsoleState = {
          entries: [],
          originals: Object.fromEntries(levels.map((level) => [level, console[level]])) as ConsoleState['originals'],
          expiresAt: Date.now() + leaseMs,
        };
        const format = (value: unknown): string => {
          if (typeof value === 'string') return value.slice(0, 2_000);
          if (value instanceof Error) return `${value.name}: ${value.message}`.slice(0, 2_000);
          try {
            return (JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item}n` : item) ?? String(value)).slice(0, 2_000);
          } catch {
            return String(value).slice(0, 2_000);
          }
        };
        for (const level of levels) {
          console[level] = (...args: unknown[]): void => {
            state.entries.push({ level, timestamp: Date.now(), text: args.map(format).join(' ').slice(0, 4_000) });
            if (state.entries.length > 100) state.entries.splice(0, state.entries.length - 100);
            state.originals[level].apply(console, args);
          };
        }
        root.__overseerConsoleV1 = state;
        state.timer = setTimeout(() => restore(state), leaseMs);
        return { installed: true, entries: 0 };
      }
      const state = root.__overseerConsoleV1;
      if (operation === 'console.read') {
        if (!state || state.expiresAt <= Date.now()) {
          if (state) restore(state);
          return { installed: false, entries: [] };
        }
        const entries = state.entries.slice();
        if (shouldClear) state.entries.length = 0;
        return { installed: true, entries };
      }
      if (state) restore(state);
      return { installed: false, stopped: Boolean(state) };
    },
    args: [command, clear, CONSOLE_LEASE_MS],
  });
  return result?.result;
}

async function restorePageConsole(tabId: number): Promise<void> {
  await runConsoleCommand(tabId, 'console.stop', false);
}

async function cleanupSessionConsoles(): Promise<void> {
  try {
    const [session] = await sessions.list();
    if (!session) return;
    await Promise.all([...new Set([...session.ownedTabIds, ...session.borrowedTabIds])].map((tabId) => sessions.cleanupTab(tabId)));
  } catch {
    // Console restoration is best effort during connection or takeover changes.
  }
}

export function redactNetworkResourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}[redacted]`;
    return `${url.origin}${url.pathname}`.slice(0, 2_000);
  } catch {
    return '[invalid-url]';
  }
}

async function readNetworkMetadata(tabId: number, requestedLimit: number): Promise<unknown> {
  const limit = Math.min(Math.max(requestedLimit, 1), 200);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (entryLimit: number): unknown => performance.getEntriesByType('resource')
      .slice(-entryLimit)
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return {
          url: resource.name.slice(0, 8_000),
          initiator_type: resource.initiatorType.slice(0, 64),
          start_time_ms: Math.round(resource.startTime * 100) / 100,
          duration_ms: Math.round(resource.duration * 100) / 100,
          transfer_size: Number.isFinite(resource.transferSize) ? resource.transferSize : 0,
          decoded_body_size: Number.isFinite(resource.decodedBodySize) ? resource.decodedBodySize : 0,
        };
      }),
    args: [limit],
  });
  const entries = Array.isArray(result?.result) ? result.result.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return null;
    const value = entry as Record<string, unknown>;
    if (typeof value.url !== 'string') return null;
    return { ...value, url: redactNetworkResourceUrl(value.url) };
  }).filter((entry) => entry !== null) : [];
  return { entries, redaction: 'query_fragment_and_non_http_content_removed', response_bodies: false };
}

async function runBatch(params: Record<string, unknown>, state: InflightRequest): Promise<unknown> {
  const rawActions = params.actions;
  if (!Array.isArray(rawActions) || rawActions.length < 1 || rawActions.length > MAX_BATCH_ACTIONS) {
    throw new DispatchError('invalid_batch', `Batch actions must contain 1–${MAX_BATCH_ACTIONS} operations.`);
  }
  if (params.stop_on_error !== undefined && typeof params.stop_on_error !== 'boolean') {
    throw new DispatchError('invalid_batch', 'stop_on_error must be boolean when supplied.');
  }
  const maxParallel = params.max_parallel === undefined
    ? 1
    : readInteger(params, 'max_parallel', 1, MAX_PARALLEL_BATCH_ACTIONS);
  const actions = rawActions.map((rawAction, index): BatchAction => {
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
      throw new DispatchError('invalid_batch', `Batch action ${index} must be an object.`);
    }
    const value = rawAction as Record<string, unknown>;
    if (typeof value.command !== 'string' || !COMMANDS.includes(value.command as Command) || !BATCHABLE_COMMANDS.has(value.command as Command)) {
      throw new DispatchError('invalid_batch_command', `Batch action ${index} uses an unsupported command.`);
    }
    if (value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params))) {
      throw new DispatchError('invalid_batch', `Batch action ${index} params must be an object.`);
    }
    return {
      command: value.command as Command,
      ...(value.params === undefined ? {} : { params: value.params as Record<string, unknown> }),
    };
  });
  if (maxParallel > 1) {
    if (params.stop_on_error !== false) {
      throw new DispatchError('invalid_batch_parallel', 'Parallel batches require stop_on_error=false because already-started actions cannot be rolled back.');
    }
    const targets = new Set<number | string>();
    for (const [index, action] of actions.entries()) {
      if (!PARALLEL_BATCH_COMMANDS.has(action.command)) {
        throw new DispatchError('invalid_batch_parallel', `Batch action ${index} is not safe for parallel execution.`);
      }
      const target = action.command === 'tabs.list'
        ? 'tabs.list'
        : readInteger(action.params ?? {}, 'tab_id', 1);
      if (targets.has(target)) {
        throw new DispatchError('invalid_batch_parallel', 'Parallel batch actions must target distinct tabs and may include tabs.list only once.');
      }
      targets.add(target);
    }
  }

  const execute = async (action: BatchAction, index: number): Promise<BatchResult> => {
    assertNotCancelled(state);
    try {
      const result = await dispatchWithinDeadline({
        version: 1,
        kind: 'request',
        request_id: `batch-${index}`,
        command: action.command,
        params: action.params,
      }, state);
      assertNotCancelled(state);
      return { ok: true, result };
    } catch (error) {
      if (state.timedOut) throw timeoutError();
      if (state.cancelled) throw cancellationError();
      return { ok: false, error: normalizeError(error) };
    }
  };

  let results: BatchResult[];
  if (maxParallel === 1) {
    results = [];
    for (const [index, action] of actions.entries()) {
      const result = await execute(action, index);
      results.push(result);
      if (!result.ok && params.stop_on_error !== false) break;
      if (!isBoundedNativeFrame(responseOk('batch', { results }))) {
        throw new DispatchError('batch_result_too_large', 'Batch results exceed the native response limit.', 'Use fewer actions or smaller observation limits.');
      }
    }
  } else {
    results = new Array<BatchResult>(actions.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < actions.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await execute(actions[index]!, index);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(maxParallel, actions.length) },
      () => worker(),
    ));
  }
  const batchResult = { results, completed: results.length, requested: actions.length, max_parallel: maxParallel };
  if (!isBoundedNativeFrame(responseOk('batch', batchResult))) {
    throw new DispatchError('batch_result_too_large', 'Batch results exceed the native response limit.', 'Use fewer actions or smaller observation limits.');
  }
  return batchResult;
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

async function userScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

async function popupState(): Promise<unknown> {
  const [activeTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const sessionsState = await sessions.list();
  const session = sessionsState[0];
  return {
    connected,
    native_enabled: nativeEnabled,
    native_error: lastNativeError,
    evaluate_enabled: evaluateEnabled,
    user_scripts_available: await userScriptsAvailable(),
    takeover_requested: takeoverRequested,
    permissions: await getPermissionState(activeTab?.url),
    sessions: sessionsState,
    telemetry_consent: await browserTelemetry().getConsent(),
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
    observeDeltas.drop(activeTab.id);
    return { ok: true, state: await popupState() };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function loadCapability(): Promise<void> {
  const value = (await browser.storage.local.get([CAPABILITY_STORAGE_KEY]))[CAPABILITY_STORAGE_KEY];
  evaluateEnabled = value === true;
}
function timeoutError(): DispatchError {
  return new DispatchError('timeout', 'Browser operation exceeded its bounded timeout.');
}

function cancellationError(): DispatchError {
  return new DispatchError('cancelled', 'Request was cancelled.');
}

function markTimedOut(state: InflightRequest): void {
  state.timedOut = true;
  state.cancelled = true;
}

export function markCancelled(state: InflightRequest): void {
  if (state.timedOut) return;
  state.cancelled = true;
  state.cancelSignalReject?.(cancellationError());
  state.cancelSignalReject = undefined;
}

function cancellationSignal(state: InflightRequest): Promise<never> {
  if (state.cancelSignal) return state.cancelSignal;
  state.cancelSignal = new Promise<never>((_resolve, reject) => {
    state.cancelSignalReject = reject;
  });
  return state.cancelSignal;
}

function assertNotCancelled(state: InflightRequest): void {
  if (state.cancelled) throw state.timedOut ? timeoutError() : cancellationError();
  if (state.deadlineAt !== undefined && Date.now() >= state.deadlineAt) {
    markTimedOut(state);
    throw timeoutError();
  }
}

export async function dispatchWithinDeadline(request: NativeRequest, state: InflightRequest): Promise<unknown> {
  assertNotCancelled(state);
  const remainingMs = state.deadlineAt === undefined ? COMMAND_TIMEOUT_MS : state.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    markTimedOut(state);
    throw timeoutError();
  }
  const action = withTimeout(dispatch(request, state), remainingMs, () => markTimedOut(state));
  return Promise.race([action, cancellationSignal(state)]);
}

function normalizeError(error: unknown): NormalizedDispatchError {
  if (error instanceof DispatchError || error instanceof SessionError || error instanceof AutomationError || error instanceof ScreenshotError || error instanceof WaitError) {
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

function readStringAllowEmpty(params: Record<string, unknown>, key: string, maxLength: number): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length > maxLength) throw new DispatchError('invalid_params', `${key} must be a string of at most ${maxLength} characters.`);
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

function optionalTabId(params: Record<string, unknown>): number | undefined {
  if (params.tab_id === undefined) return undefined;
  return readInteger(params, 'tab_id', 1);
}
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timeout: TimerHandle | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new DispatchError('timeout', 'Browser operation exceeded its bounded timeout.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export default defineBackground(() => {
  startBackground();
});