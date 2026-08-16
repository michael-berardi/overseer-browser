import { describe, expect, it, vi } from 'vitest';
import { OPTIONAL_ORIGINS, canControlUrl, getPermissionState, hasOptionalSiteAccess, isMeetingUrl, isNavigableUrl, originPatternForUrl, requestOptionalSiteAccess, requestOriginAccess, revokeOptionalSiteAccess, revokeOriginAccess } from '../src/permissions';

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

  it('keeps full-site control optional while enabling explicitly granted screenshots', () => {
    expect(OPTIONAL_ORIGINS).toEqual(['<all_urls>']);
  });
  it('treats a granted all_urls permission as trust for any site, with per-origin grants as fallback', async () => {
    const localStore: Record<string, unknown> = {};
    let exactOriginGranted = false;
    let allUrlsGranted = true;
    const contains = vi.fn(async ({ origins }: { origins: string[] }) =>
      (origins[0] === '<all_urls>' && allUrlsGranted) || (origins[0] === 'https://example.test/*' && exactOriginGranted));
    const request = vi.fn(async ({ origins }: { origins: string[] }) => {
      if (origins[0] === '<all_urls>') { allUrlsGranted = true; return true; }
      exactOriginGranted = origins[0] === 'https://example.test/*';
      return exactOriginGranted;
    });
    const remove = vi.fn(async ({ origins }: { origins: string[] }) => {
      if (origins[0] === '<all_urls>') allUrlsGranted = false;
      if (origins[0] === 'https://example.test/*') exactOriginGranted = false;
      return true;
    });
    vi.stubGlobal('browser', {
      permissions: { contains, request, remove },
      storage: {
        local: {
          get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in localStore).map((key, ) => [key, localStore[key]])),
          set: async (values: Record<string, unknown>) => Object.assign(localStore, values),
        },
      },
    });

    // Broad trust: any navigable site is controllable without a per-site grant.
    await expect(hasOptionalSiteAccess()).resolves.toBe(true);
    await expect(canControlUrl('https://example.test/path')).resolves.toBe(true);
    await expect(canControlUrl('https://never-seen-before.test/page')).resolves.toBe(true);
    await expect(canControlUrl('file:///tmp/file')).resolves.toBe(false);
    await expect(getPermissionState('https://example.test/path')).resolves.toMatchObject({
      optionalSiteAccess: true,
      currentOriginAccess: true,
    });
    expect(request).not.toHaveBeenCalled();

    // Revoking the broad grant falls back to exact per-origin gating.
    await expect(revokeOptionalSiteAccess()).resolves.toBe(true);
    await expect(canControlUrl('https://example.test/path')).resolves.toBe(false);
    await expect(requestOriginAccess('https://example.test/path')).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['https://example.test/*'] });
    await expect(canControlUrl('https://example.test/path')).resolves.toBe(true);
    await expect(revokeOriginAccess('https://example.test/path')).resolves.toBe(true);
    await expect(canControlUrl('https://example.test/path')).resolves.toBe(false);
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

    await expect(requestOptionalSiteAccess()).resolves.toBe(false);
    expect(request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    request.mockClear();
    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(false);
    await expect(getPermissionState('https://meet.google.com/abc-defg-hij')).resolves.toMatchObject({ currentOriginAccess: false });
    await expect(requestOriginAccess('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    await expect(revokeOriginAccess('https://meet.google.com/abc-defg-hij')).resolves.toBe(true);
    await expect(canControlUrl('https://meet.google.com/abc-defg-hij')).resolves.toBe(false);
  });
});
