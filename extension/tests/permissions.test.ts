import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_SITE_ORIGINS,
  normalizeSiteAccess,
  getPermissionState,
  isNavigableUrl,
  setAllSiteAccess,
  setCurrentOriginAccess,
} from '../src/permissions';

afterEach(() => vi.unstubAllGlobals());

function storageArea(store: Record<string, unknown>) {
  return {
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: vi.fn(async (key: string) => delete store[key]),
  };
}

describe('scoped site access', () => {
  it('allows HTTP and HTTPS navigation while rejecting executable and internal schemes', () => {
    expect(isNavigableUrl('http://example.test')).toBe(true);
    expect(isNavigableUrl('https://example.test/path')).toBe(true);
    expect(isNavigableUrl('file:///tmp/file')).toBe(false);
    expect(isNavigableUrl('chrome://settings')).toBe(false);
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
  });

  it('reports an independently granted current origin', async () => {
    const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins[0] === 'https://example.test/*');
    const local = storageArea({ 'overseer.site.origins.v2': ['https://example.test/*'] });
    vi.stubGlobal('browser', { permissions: { contains }, storage: { local } });

    await expect(getPermissionState('https://example.test/path')).resolves.toEqual({
      meetingHosts: true,
      optionalSiteAccess: true,
      currentOrigin: 'https://example.test/*',
      currentOriginAccess: true,
      allSiteAccess: false,
    });
    expect(contains).not.toHaveBeenCalledWith({ origins: [...ALL_SITE_ORIGINS] });
    expect(contains).toHaveBeenCalledWith({ origins: ['https://example.test/*'] });
  });

  it('reports unlimited access without a current-origin query', async () => {
    const contains = vi.fn(async () => true);
    const local = storageArea({ 'overseer.site.unlimited.v2': true });
    vi.stubGlobal('browser', { permissions: { contains }, storage: { local } });

    await expect(getPermissionState('https://example.test/path')).resolves.toMatchObject({
      optionalSiteAccess: true,
      currentOriginAccess: true,
      allSiteAccess: true,
    });
    expect(contains).toHaveBeenCalledTimes(1);
  });

  it('requests and removes current-site and unlimited grants through Chrome permissions', async () => {
    const request = vi.fn(async () => true);
    const remove = vi.fn(async () => true);
    const local = storageArea({});
    vi.stubGlobal('browser', { permissions: { request, remove }, storage: { local } });

    await expect(setCurrentOriginAccess('https://example.test/path', true)).resolves.toBe(true);
    await expect(setCurrentOriginAccess('https://example.test/path', false)).resolves.toBe(true);
    await expect(setAllSiteAccess(true)).resolves.toBe(true);
    await expect(setAllSiteAccess(false)).resolves.toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, { origins: ['https://example.test/*'] });
    expect(remove).toHaveBeenNthCalledWith(1, { origins: ['https://example.test/*'] });
    expect(request).toHaveBeenNthCalledWith(2, { origins: [...ALL_SITE_ORIGINS] });
    expect(remove).toHaveBeenNthCalledWith(2, { origins: [...ALL_SITE_ORIGINS] });
  });

  it('revokes inherited all-site access unless unlimited was explicitly enabled', async () => {
    const local = storageArea({});
    const remove = vi.fn(async () => true);
    vi.stubGlobal('browser', { storage: { local }, permissions: { remove } });

    await normalizeSiteAccess();
    expect(local.remove).toHaveBeenCalledWith('overseer.automation.origins.v1');
    expect(remove).toHaveBeenCalledWith({ origins: [...ALL_SITE_ORIGINS] });
  });
});
