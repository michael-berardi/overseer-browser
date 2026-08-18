const ALL_SITE_ORIGINS = ['<all_urls>'] as const;
const LEGACY_AUTOMATION_ORIGINS_KEY = 'overseer.automation.origins.v1';

export function isNavigableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function originPatternForUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/*` : undefined;
  } catch {
    return undefined;
  }
}

export interface PermissionState {
  meetingHosts: true;
  optionalSiteAccess: boolean;
  currentOrigin?: string;
  currentOriginAccess: boolean;
  allSiteAccess: boolean;
}

export async function clearLegacyAutomationOrigins(): Promise<void> {
  await browser.storage.local.remove(LEGACY_AUTOMATION_ORIGINS_KEY);
}

export async function getPermissionState(currentUrl?: string): Promise<PermissionState> {
  let allSiteAccess = false;
  try {
    allSiteAccess = await browser.permissions.contains({ origins: [...ALL_SITE_ORIGINS] });
  } catch {
    // Report unavailable permission state as disabled.
  }
  const currentOrigin = currentUrl ? originPatternForUrl(currentUrl) : undefined;
  return {
    meetingHosts: true,
    optionalSiteAccess: allSiteAccess,
    ...(currentOrigin ? { currentOrigin } : {}),
    currentOriginAccess: currentOrigin !== undefined && allSiteAccess,
    allSiteAccess,
  };
}
