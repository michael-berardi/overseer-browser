export const PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = 'com.imploselabs.overseer_browser';
export const EXTENSION_ID = 'iabfdeokmilpklblkgccpjlekchfjcno';
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_NATIVE_FRAME_BYTES = 900 * 1024;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const COMMANDS = [
  'health.status', 'sessions.start', 'sessions.stop', 'sessions.list', 'windows.resize',
  'tabs.list', 'tabs.create', 'tabs.select', 'tabs.close', 'tabs.borrow', 'tabs.return',
  'navigate', 'back', 'forward', 'reload', 'snapshot', 'observe', 'click', 'hover', 'fill',
  'type', 'select', 'press', 'scroll', 'evaluate', 'screenshot.visible', 'screenshot.element',
  'upload', 'batch', 'console.start', 'console.read', 'console.stop', 'network.read',
  'takeover.prompt', 'cancel', 'capture.start', 'capture.stop',
] as const;

export type Command = (typeof COMMANDS)[number];
export type Provider = 'google_meet' | 'zoom';

export interface NativeRequest {
  version: 1;
  kind: 'request';
  request_id: string;
  command: string;
  params?: Record<string, unknown>;
}

export interface NativeResponse {
  version: 1;
  kind: 'response';
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; reason?: string; fallback?: string };
}

export interface MeetingDetection {
  version: 1;
  detection_id: string;
  provider: Provider;
  meeting_key: string;
  detected_at_ms: number;
}

export interface MeetingEvent {
  version: 1;
  kind: 'meeting_detected';
  payload: MeetingDetection;
}

export interface NativeHello {
  version: 1;
  kind: 'handshake';
  extension_id: string;
  capabilities: string[];
}

export interface NativeHandshakeAck {
  version: 1;
  kind: 'handshake_ack';
  ok: boolean;
  error?: string;
}
export interface NativeMeetingAck {
  version: 1;
  kind: 'meeting_ack';
  detection_id: string;
  delivered: boolean;
}
export interface NativeHostError {
  version: 1;
  kind: 'error';
  error: ProtocolError;
}



export type NativeOutbound = NativeHello | NativeResponse | MeetingEvent;

export interface ProtocolError {
  code: string;
  message: string;
  reason?: string;
  fallback?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNativeHandshakeAck(value: unknown): value is NativeHandshakeAck {
  if (!isPlainObject(value) || value.version !== 1 || value.kind !== 'handshake_ack' || typeof value.ok !== 'boolean') return false;
  return value.error === undefined || (typeof value.error === 'string' && value.error.length <= 4_096);
}
export function isNativeMeetingAck(value: unknown): value is NativeMeetingAck {
  return isPlainObject(value) && value.version === 1 && value.kind === 'meeting_ack' &&
    typeof value.detection_id === 'string' && value.detection_id.length >= 1 &&
    value.detection_id.length <= 128 && typeof value.delivered === 'boolean';
}
export function isNativeHostError(value: unknown): value is NativeHostError {
  if (!isPlainObject(value) || value.version !== 1 || value.kind !== 'error' || !isPlainObject(value.error)) return false;
  const { code, message, reason, fallback } = value.error;
  return typeof code === 'string' && code.length >= 1 && code.length <= 96 &&
    typeof message === 'string' && message.length >= 1 && message.length <= 4_096 &&
    (reason === undefined || (typeof reason === 'string' && reason.length <= 4_096)) &&
    (fallback === undefined || (typeof fallback === 'string' && fallback.length <= 4_096));
}



export function parseNativeRequest(value: unknown): { ok: true; request: NativeRequest } | { ok: false; error: ProtocolError } {
  if (!isPlainObject(value)) return invalid('invalid_request', 'Request must be an object.');
  if (value.version !== PROTOCOL_VERSION || value.kind !== 'request') return invalid('unsupported_version', 'Request protocol version or kind is unsupported.');
  if (typeof value.request_id !== 'string' || value.request_id.length < 1 || value.request_id.length > 128) return invalid('invalid_request_id', 'request_id must be 1–128 characters.');
  if (typeof value.command !== 'string' || value.command.length < 1 || value.command.length > 96) return invalid('invalid_command', 'command must be 1–96 characters.');
  if (value.params !== undefined && !isPlainObject(value.params)) return invalid('invalid_params', 'params must be an object when supplied.');
  if (serializedFrameBytes(value) > MAX_REQUEST_BYTES) return invalid('request_too_large', 'Request exceeds the bounded native message size.');
  return { ok: true, request: { version: 1, kind: 'request', request_id: value.request_id, command: value.command, params: value.params as Record<string, unknown> | undefined } };
}

export function serializedFrameBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isBoundedNativeFrame(value: unknown): boolean {
  return serializedFrameBytes(value) <= MAX_NATIVE_FRAME_BYTES;
}

export function responseOk(requestId: string, result: unknown): NativeResponse {
  return { version: 1, kind: 'response', request_id: requestId, ok: true, result };
}

export function responseError(requestId: string, error: ProtocolError): NativeResponse {
  return { version: 1, kind: 'response', request_id: requestId, ok: false, error };
}

export function invalid(code: string, message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code, message } };
}

export function isProvider(value: unknown): value is Provider {
  return value === 'google_meet' || value === 'zoom';
}

export function isMeetingDetection(value: unknown): value is MeetingDetection {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'detected_at_ms,detection_id,meeting_key,provider,version' && value.version === 1 &&
    typeof value.detection_id === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.detection_id) &&
    isProvider(value.provider) && typeof value.meeting_key === 'string' && /^[0-9a-f]{64}$/.test(value.meeting_key) &&
    typeof value.detected_at_ms === 'number' && Number.isFinite(value.detected_at_ms);
}
