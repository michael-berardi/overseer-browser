import { describe, expect, it } from 'vitest';
import { COMMANDS, isBoundedNativeFrame, isMeetingDetection, isNativeHandshakeAck, isNativeHostError, isNativeMeetingAck, parseNativeRequest, serializedFrameBytes, type NativeHello } from '../src/protocol';
import { MAX_SCREENSHOT_FRAME_BYTES } from '../src/screenshot';

describe('native protocol validation', () => {
  it('publishes every required command with explicit dotted names', () => {
    expect(COMMANDS).toEqual(expect.arrayContaining(['health.status', 'sessions.start', 'tabs.borrow', 'tabs.return', 'snapshot', 'evaluate', 'screenshot.element', 'upload', 'batch', 'console.start', 'console.read', 'console.stop', 'network.read', 'cancel']));
    expect(COMMANDS).not.toContain('capability.set');
  });
  it('matches the native host handshake fixture', () => {
    const handshake: NativeHello = { version: 1, kind: 'handshake', extension_id: 'iabfdeokmilpklblkgccpjlekchfjcno', capabilities: ['health.status'] };
    expect(handshake.kind).toBe('handshake');
    expect(isNativeHandshakeAck({ version: 1, kind: 'handshake_ack', ok: 'yes' })).toBe(false);
    expect(isNativeHandshakeAck({ version: 1, kind: 'handshake_ack', ok: true })).toBe(true);
    expect(isNativeHandshakeAck({ version: 1, kind: 'handshake_ack', ok: false, error: 'denied' })).toBe(true);
    expect(isNativeHandshakeAck({ version: 1, kind: 'handshake_ack' })).toBe(false);
  });
  it('validates versioned requests and rejects unbounded input', () => {
    expect(parseNativeRequest({ version: 1, kind: 'request', request_id: 'r1', command: 'health.status' }).ok).toBe(true);
    expect(parseNativeRequest({ version: 2, kind: 'request', request_id: 'r1', command: 'health.status' }).ok).toBe(false);
    expect(parseNativeRequest({ version: 1, kind: 'request', request_id: 'r1', command: 'health.status', params: 'bad' }).ok).toBe(false);
    expect(parseNativeRequest({ version: 1, kind: 'request', request_id: 'r1', command: 'upload', params: { chunk: 'x'.repeat(700_000) } }).ok).toBe(false);
  });

  it('does not treat the handshake acknowledgement as a request', () => {
    expect(isNativeHandshakeAck({ version: 1, kind: 'handshake_ack', ok: true })).toBe(true);
    expect(parseNativeRequest({ version: 1, kind: 'handshake_ack', ok: true }).ok).toBe(false);
  });

  it('validates meeting delivery acknowledgements', () => {
    expect(isNativeMeetingAck({ version: 1, kind: 'meeting_ack', detection_id: 'detection-1', delivered: true })).toBe(true);
    expect(isNativeMeetingAck({ version: 1, kind: 'meeting_ack', detection_id: 'detection-1', delivered: 'yes' })).toBe(false);
  });

  it('validates bounded native-host error frames', () => {
    expect(isNativeHostError({
      version: 1,
      kind: 'error',
      error: { code: 'protocol_error', message: 'invalid frame length' },
    })).toBe(true);
    expect(isNativeHostError({
      version: 1,
      kind: 'error',
      error: { code: 'protocol_error', message: 'x'.repeat(4_097) },
    })).toBe(false);
  });

  it('accepts only the exact minimized meeting payload', () => {
    const detection = {
      version: 1,
      detection_id: 'detection-1',
      provider: 'google_meet',
      meeting_key: 'a'.repeat(64),
      detected_at_ms: 1_000,
    };
    expect(isMeetingDetection(detection)).toBe(true);
    expect(isMeetingDetection({ ...detection, url: 'https://meet.google.com/abc-defg-hij' })).toBe(false);
  });

  it('keeps response frames below Chrome native messaging limits', () => {
    const response = { version: 1, kind: 'response', request_id: 'shot', ok: true, result: { format: 'jpeg', data: 'A'.repeat(600_000) } };
    expect(serializedFrameBytes(response)).toBeLessThan(900 * 1024);
    expect(isBoundedNativeFrame(response)).toBe(true);
    expect(MAX_SCREENSHOT_FRAME_BYTES).toBeLessThan(900 * 1024);
  });

  it('rejects non-serializable evaluation results without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializedFrameBytes({ result: 1n })).toBe(Number.POSITIVE_INFINITY);
    expect(serializedFrameBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(isBoundedNativeFrame({ result: 1n })).toBe(false);
    expect(isBoundedNativeFrame(cyclic)).toBe(false);
  });
});
