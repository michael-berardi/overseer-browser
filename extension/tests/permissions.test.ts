import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLegacyAutomationOrigins, getPermissionState, isNavigableUrl } from '../src/permissions';

afterEach(() => vi.unstubAllGlobals());

describe('autonomous site access', () => {
  it('allows every HTTP and HTTPS origin without a runtime grant', () => {
    expect(isNavigableUrl('http://example.test')).toBe(true);
    expect(isNavigableUrl('https://example.test')).toBe(true);
    expect(isNavigableUrl('https://never-seen-before.test/path')).toBe(true);
  });

  it('rejects browser-internal and executable URL schemes', () => {
    expect(isNavigableUrl('file:///tmp/file')).toBe(false);
    expect(isNavigableUrl('chrome://settings')).toBe(false);
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
  });

  it('reports effective all-site access while retaining version-one fields', async () => {
    const contains = vi.fn(async () => true);
    vi.stubGlobal('browser', { permissions: { contains } });

    await expect(getPermissionState('https://example.test/path')).resolves.toEqual({
      meetingHosts: true,
      optionalSiteAccess: true,
      currentOrigin: 'https://example.test/*',
      currentOriginAccess: true,
      allSiteAccess: true,
    });
    expect(contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('reports restricted Chrome site access without requesting permission', async () => {
    vi.stubGlobal('browser', { permissions: { contains: vi.fn(async () => false) } });

    await expect(getPermissionState('https://example.test/path')).resolves.toMatchObject({
      optionalSiteAccess: false,
      currentOriginAccess: false,
      allSiteAccess: false,
    });
  });

  it('deletes the obsolete per-origin allowlist during startup migration', async () => {
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { storage: { local: { remove } } });

    await clearLegacyAutomationOrigins();
    expect(remove).toHaveBeenCalledWith('overseer.automation.origins.v1');
  });
});
