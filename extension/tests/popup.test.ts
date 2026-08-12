import { describe, expect, it } from 'vitest';
import {
  MEETING_HOST_POLICY,
  connectionStatusPresentation,
  formatPopupError,
  isFailedRuntimeReply,
} from '../entrypoints/popup/App';

describe('popup meeting host disclosure', () => {
  it('names the exact Meet host and Zoom provider subdomains', () => {
    expect(MEETING_HOST_POLICY).toContain('meet.google.com');
    expect(MEETING_HOST_POLICY).toContain('Zoom provider subdomains');
    expect(MEETING_HOST_POLICY).toContain('us02web.zoom.us');
  });
});

describe('popup connection status accessibility', () => {
  it('uses a live status presentation for connected and disconnected states', () => {
    expect(connectionStatusPresentation(true)).toEqual({
      label: 'Connected',
      role: 'status',
      ariaLive: 'polite',
      ariaAtomic: 'true',
    });
    expect(connectionStatusPresentation(false)).toEqual({
      label: 'Disconnected',
      role: 'status',
      ariaLive: 'polite',
      ariaAtomic: 'true',
    });
  });
});

describe('popup runtime error handling', () => {
  it('recognizes negative runtime replies without enabling a control', () => {
    expect(isFailedRuntimeReply({ ok: false, error: { message: 'native host unavailable' } })).toBe(true);
    expect(isFailedRuntimeReply({ ok: true })).toBe(false);
    expect(isFailedRuntimeReply({ enabled: false })).toBe(false);
  });

  it('surfaces concise, bounded errors for live popup feedback', () => {
    expect(formatPopupError('Refresh failed', new Error('native host unavailable'))).toBe('Refresh failed: native host unavailable');
    expect(formatPopupError('Control failed', { message: 'x'.repeat(300) })).toHaveLength(160);
    expect(formatPopupError('Control failed', undefined)).toBe('Control failed.');
  });
});
