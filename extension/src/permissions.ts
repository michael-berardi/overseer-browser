export const ALL_SITE_ORIGINS = ['http://*/*', 'https://*/*'] as const;
/**
 * chrome.tabs.captureVisibleTab only honors '<all_urls>' (or activeTab), not
 * wildcard per-scheme grants, so unlimited access requests this pattern.
 * Legacy unlimited installs hold ALL_SITE_ORIGINS instead and keep full
 * automation access; only screenshots require re-granting unlimited once.
 */
export const ALL_URLS_ORIGIN = '<all_urls>';
const LEGACY_AUTOMATION_ORIGINS_KEY = 'overseer.automation.origins.v1';
const SITE_ORIGINS_KEY = 'overseer.site.origins.v2';
const UNLIMITED_SITE_ACCESS_KEY = 'overseer.site.unlimited.v2';

export function isNavigableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function originPatternForUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

function validStoredOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && originPatternForUrl(item) === item))];
}

async function storedSiteAccess(): Promise<{ origins: string[]; unlimited: boolean }> {
  const values = await browser.storage.local.get([SITE_ORIGINS_KEY, UNLIMITED_SITE_ACCESS_KEY]);
  return {
    origins: validStoredOrigins(values[SITE_ORIGINS_KEY]),
    unlimited: values[UNLIMITED_SITE_ACCESS_KEY] === true,
  };
}

export interface PermissionState {
  meetingHosts: true;
  optionalSiteAccess: boolean;
  currentOrigin?: string;
  currentOriginAccess: boolean;
  allSiteAccess: boolean;
}

export async function normalizeSiteAccess(): Promise<void> {
  await browser.storage.local.remove(LEGACY_AUTOMATION_ORIGINS_KEY);
  const stored = await storedSiteAccess();
  if (!stored.unlimited) await browser.permissions.remove({ origins: [ALL_URLS_ORIGIN, ...ALL_SITE_ORIGINS] });
  await browser.storage.local.set({ [SITE_ORIGINS_KEY]: stored.origins });
}

export async function setCurrentOriginAccess(rawUrl: string, enabled: boolean): Promise<boolean> {
  const origin = originPatternForUrl(rawUrl);
  if (!origin) return false;
  if (enabled) {
    const granted = await browser.permissions.request({ origins: [origin] });
    if (!granted) return false;
    const stored = await storedSiteAccess();
    await browser.storage.local.set({ [SITE_ORIGINS_KEY]: [...new Set([...stored.origins, origin])] });
    return true;
  }
  const stored = await storedSiteAccess();
  const hadOrigin = stored.origins.includes(origin);
  await browser.storage.local.set({ [SITE_ORIGINS_KEY]: stored.origins.filter((item) => item !== origin) });
  const removed = await browser.permissions.remove({ origins: [origin] });
  return hadOrigin || removed;
}

export async function setAllSiteAccess(enabled: boolean): Promise<boolean> {
  if (enabled) {
    const granted = await browser.permissions.request({ origins: [ALL_URLS_ORIGIN] });
    if (!granted) return false;
    await browser.storage.local.set({ [UNLIMITED_SITE_ACCESS_KEY]: true });
    return true;
  }
  const stored = await storedSiteAccess();
  await browser.storage.local.set({ [UNLIMITED_SITE_ACCESS_KEY]: false });
  const removed = await browser.permissions.remove({ origins: [ALL_URLS_ORIGIN, ...ALL_SITE_ORIGINS] });
  return stored.unlimited || removed;
}

export async function getPermissionState(currentUrl?: string): Promise<PermissionState> {
  const stored = await storedSiteAccess();
  let allSiteAccess = false;
  if (stored.unlimited) {
    try {
      allSiteAccess =
        (await browser.permissions.contains({ origins: [ALL_URLS_ORIGIN] })) ||
        (await browser.permissions.contains({ origins: [...ALL_SITE_ORIGINS] }));
    } catch {
      // Report unavailable permission state as disabled.
    }
  }
  const currentOrigin = currentUrl ? originPatternForUrl(currentUrl) : undefined;
  let currentOriginAccess = allSiteAccess;
  if (!currentOriginAccess && currentOrigin && stored.origins.includes(currentOrigin)) {
    try {
      currentOriginAccess = await browser.permissions.contains({ origins: [currentOrigin] });
    } catch {
      // Report unavailable permission state as disabled.
    }
  }
  return {
    meetingHosts: true,
    optionalSiteAccess: currentOriginAccess,
    ...(currentOrigin ? { currentOrigin } : {}),
    currentOriginAccess,
    allSiteAccess,
  };
}
