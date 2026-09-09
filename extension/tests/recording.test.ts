import { describe, it, expect } from 'vitest';
import { recordingOptions, RECORD_CHUNK } from '../src/recording';
describe('native recording bounds', () => {
  it('accepts 1–60 FPS without asserting achieved FPS', () => {
    expect(recordingOptions({fps: 1}).fps).toBe(1);
    expect(recordingOptions({fps: 60}).fps).toBe(60);
    expect(RECORD_CHUNK * 4 / 3).toBeLessThan(900 * 1024);
  });
  it('rejects malformed and unbounded requests', () => {
    for (const p of [{fps: 61}, {fps: 0}, {fps: 1.5}, {seconds: 301}, {max_bytes: 67108865}, {fps: '30'}]) expect(() => recordingOptions(p)).toThrow();
  });
});

import { vi } from 'vitest';
describe('consent and ownership lifecycle', () => {
  it('denies consent, rejects peer sessions, cancels, and restarts without touching pages', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => ({phase: 'stopped'}));
    vi.stubGlobal('chrome', {runtime: {sendMessage}, offscreen: {hasDocument: async () => true, closeDocument: vi.fn()}});
    const {recordCommand, recordingPopup} = await import('../src/recording_bridge');
    const p: any = await recordCommand('start', 'owner', 7, {fps: 60});
    expect(p.phase).toBe('consent_required');
    await expect(recordCommand('stop', 'peer', 7, {})).rejects.toThrow('wrong_session');
    await recordingPopup({kind: 'record_deny', token: p.token}, async () => true);
    expect((await recordCommand('status', 'owner', 7, {})).phase).toBe('denied');
    const next: any = await recordCommand('restart', 'owner', 7, {});
    expect(next.tabId).toBe(7);
    expect(next.token).not.toBe(p.token);
    await recordCommand('stop', 'owner', 7, {});
    await expect(recordingPopup({kind: 'record_approve', token: next.token}, async () => true)).rejects.toThrow();
    await recordCommand('clear', 'owner', 7, {});
    expect((await recordCommand('status', 'owner', 7, {})).phase).toBe('idle');
    // No tabs/windows API exists in this test: restart cannot navigate or close a page.
  });
});

describe('recording safety gates', () => {
  async function setup() {
    vi.resetModules();
    const sendMessage = vi.fn(async () => ({phase: 'stopped'}));
    const closeDocument = vi.fn(async () => {});
    vi.stubGlobal('chrome', {runtime: {sendMessage}, offscreen: {hasDocument: async () => true, closeDocument}, tabCapture: {getMediaStreamId: vi.fn((_: unknown, cb: (id: string) => void) => cb(''))}});
    return {...await import('../src/recording_bridge'), sendMessage, closeDocument};
  }
  it('expires consent and conceals a request from the wrong active tab', async () => {
    vi.useFakeTimers();
    try {
      const b = await setup();
      const p: any = await b.recordCommand('start', 's', 1, {});
      expect(await b.recordingPopup({kind: 'record_pending'}, async () => false)).toBeNull();
      await vi.advanceTimersByTimeAsync(b.CONSENT_MS);
      expect((await b.recordCommand('status', 's', 1, {})).phase).toBe('expired');
      await expect(b.recordingPopup({kind: 'record_approve', token: p.token}, async () => true)).rejects.toThrow();
      await b.recordingCleanup();
    } finally { vi.useRealTimers(); }
  });
  it('permission denial is terminal and restart generates fresh consent', async () => {
    const b = await setup();
    const p: any = await b.recordCommand('start', 's', 1, {});
    await expect(b.recordingPopup({kind: 'record_approve', token: p.token}, async () => true)).rejects.toThrow('denied');
    expect((await b.recordCommand('status', 's', 1, {})).phase).toBe('denied');
    expect((await b.recordCommand('restart', 's', 1, {})).token).not.toBe(p.token);
    await b.recordingCleanup();
  });
  it('tab closure clears only the recording tab and repeated cleanup is safe', async () => {
    const b = await setup();
    await b.recordCommand('start', 's', 7, {});
    await b.recordingCleanup(8);
    expect((await b.recordCommand('status', 's', 7, {})).phase).toBe('consent_required');
    await b.recordingCleanup(7); await b.recordingCleanup();
    expect((await b.recordCommand('stop', 's', 7, {})).phase).toBe('idle');
    expect(b.closeDocument).toHaveBeenCalled();
  });
  it('reserves session ownership before async setup finishes', async () => {
    const b = await setup();
    const first = b.recordCommand('start', 'a', 7, {});
    await expect(b.recordCommand('start', 'b', 7, {})).rejects.toThrow('wrong_session');
    await first; await b.recordingCleanup();
  });
});
