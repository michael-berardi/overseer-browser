import { describe, expect, it, vi } from 'vitest';
import { canControlUrl, getPermissionState, isMeetingUrl, isNavigableUrl, originPatternForUrl, requestOriginAccess, revokeOriginAccess } from '../src/permissions';

describe('permission gating', () => {
  it('keeps meeting origins exact while deriving one-origin grants for general control', () => {
    expect(isMeetingUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(isMeetingUrl('https://zoom.us/j/123456789')).toBe(true);
    expect(isMeetingUrl('https://zoom.us.evil.example/j/123456789')).toBe(false);
    expect(originPatternForUrl('https://example.test:8443/path?q=1')).toBe('https://example.test:8443/*');
    expect(originPatternForUrl('chrome://settings')).toBeNull();
  });

  it('allows navigation schemes only for http and https', () => {
    expect(isNavigableUrl('http://example.test')).toBe(true);
    expect(isNavigableUrl('https://example.test')).toBe(true);
    expect(isNavigableUrl('file:///tmp/file')).toBe(false);
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
  });

  it('keeps required meeting host access separate from popup-confirmed automation access', async () => {
    const localStore: Record<string, unknown> = {};
    const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.length === 1 && origins[0] === 'https://meet.google.com/*');
    const request = vi.fn(async () => false);
    const remove = vi.fn(async () => true);
    vi.stubGlobal('browser', {
      permissions: { contains, request, remove },
      storage: {
        local: {
          get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in localStore).map((key) => [key, localStore[key]])),
          set: async (values: Record<string, unknown>) => Object.assign(localStore, values),
          remove: async (key: string) => delete localStore[key],
        },
      },
    });

    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(false);
    await expect(getPermissionState('https://meet.google.com/abc-defg-hij')).resolves.toMatchObject({ currentOriginAccess: false });
    await expect(requestOriginAccess('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    await expect(revokeOriginAccess('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(false);
  });
});
