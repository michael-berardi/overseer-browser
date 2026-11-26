import { describe, expect, it } from 'vitest';
import {
  MEETING_HOST_POLICY,
  SITE_ACCESS_POLICY,
  connectionActionLabel,
  connectionStatusPresentation,
  formatPopupError,
  isFailedRuntimeReply,
  updateBannerPresentation,
  updateHeading,
  UPDATE_PRIVACY,
} from '../entrypoints/popup/App';

describe('popup meeting host disclosure', () => {
  it('names the exact Meet host and Zoom provider subdomains', () => {
    expect(MEETING_HOST_POLICY).toContain('meet.google.com');
    expect(MEETING_HOST_POLICY).toContain('Zoom provider subdomains');
    expect(MEETING_HOST_POLICY).toContain('us02web.zoom.us');
  });
});

describe('popup scoped site access disclosure', () => {
  it('states the secure default and both user-controlled access scopes', () => {
    expect(SITE_ACCESS_POLICY).toContain('off by default');
    expect(SITE_ACCESS_POLICY).toContain('current site');
    expect(SITE_ACCESS_POLICY).toContain('unlimited access');
    expect(SITE_ACCESS_POLICY).toContain('session-owned or explicitly borrowed tab');
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

  it('distinguishes disconnect, reconnect cancellation, and initial connection actions', () => {
    expect(connectionActionLabel(true, true)).toBe('Disconnect');
    expect(connectionActionLabel(false, true)).toBe('Stop reconnecting');
    expect(connectionActionLabel(false, false)).toBe('Connect local host');
  });
});

describe('popup updates section', () => {
  const status = {
    available: true, current: '0.11.0', latest: '0.12.0', notes: 'New release.', installing: false,
    installed: false, auto: false, checks: true, error: '', command: 'overseer-browser update',
  };

  it('offers Install, Skip and Later only for a newer release reported by the host', () => {
    expect(updateBannerPresentation(status)).toEqual({
      message: 'OverSeer Browser 0.12.0 is available — you have 0.11.0.',
      notes: 'New release.',
      actions: true,
    });
    expect(updateHeading(status)).toBe('Update available');
    expect(updateBannerPresentation(null)).toBeNull();
    expect(updateBannerPresentation({ ...status, available: false })).toBeNull();
    expect(updateBannerPresentation({ ...status, latest: null })).toBeNull();
  });

  it('hides actions while installing and asks for a reload once installed', () => {
    expect(updateBannerPresentation({ ...status, installing: true })?.actions).toBe(false);
    expect(updateHeading({ ...status, installing: true })).toBe('Installing 0.12.0…');
    expect(updateBannerPresentation({ ...status, installed: true })).toEqual({
      message: 'OverSeer Browser 0.12.0 is installed. Reload it in chrome://extensions to finish.', notes: '', actions: false,
    });
  });

  it('reports current, failed and unchecked states without flavor text', () => {
    expect(updateHeading({ ...status, available: false })).toBe('Up to date');
    expect(updateHeading({ ...status, available: false, error: 'HTTP 403 from the release server' })).toBe('Last check failed');
    expect(updateHeading(null)).toBe('Not checked yet');
    expect(UPDATE_PRIVACY).toContain('makes no request of its own');
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
