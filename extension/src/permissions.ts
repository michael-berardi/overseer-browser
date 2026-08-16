const EXPLICIT_AUTOMATION_ORIGINS_KEY = 'overseer.automation.origins.v1';
const MAX_EXPLICIT_AUTOMATION_ORIGINS = 32;
const MAX_ORIGIN_PATTERN_LENGTH = 256;

export const REQUIRED_PERMISSIONS = [
  'nativeMessaging',
  'storage',
  'scripting',
  'tabs',
  'windows',
  'activeTab',
] as const;

export const MEETING_ORIGINS = [
  'https://meet.google.com/*',
  'https://zoom.us/*',
  'https://*.zoom.us/*',
] as const;

export const OPTIONAL_ORIGINS = ['<all_urls>'] as const;

export function isMeetingUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'meet.google.com' || host === 'zoom.us' || host.endsWith('.zoom.us'));
  } catch {
    return false;
  }
}

export function originPatternForUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

function isValidOriginPattern(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_PATTERN_LENGTH || !value.endsWith('/*')) return false;
  try {
    const url = new URL(value.slice(0, -2));
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash &&
      originPatternForUrl(`${url.origin}/`) === value;
  } catch {
    return false;
  }
}


async function readExplicitAutomationOrigins(): Promise<string[]> {
  const stored = (await browser.storage.local.get([EXPLICIT_AUTOMATION_ORIGINS_KEY]))[EXPLICIT_AUTOMATION_ORIGINS_KEY];
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter(isValidOriginPattern))].slice(0, MAX_EXPLICIT_AUTOMATION_ORIGINS);
}

async function writeExplicitAutomationOrigins(origins: string[]): Promise<void> {
  const valid = [...new Set(origins.filter(isValidOriginPattern))].slice(0, MAX_EXPLICIT_AUTOMATION_ORIGINS);
  await browser.storage.local.set({ [EXPLICIT_AUTOMATION_ORIGINS_KEY]: valid });
}

async function hasExplicitAutomationOrigin(rawUrl: string): Promise<boolean> {
  // A granted <all_urls> optional permission means the operator trusts the
  // agent on any site; the per-origin list is only the fallback for the
  // narrower configuration.
  if (await hasOptionalSiteAccess()) return isNavigableUrl(rawUrl);
  const pattern = originPatternForUrl(rawUrl);
  if (pattern === null || !(await readExplicitAutomationOrigins()).includes(pattern)) return false;
  return isMeetingUrl(rawUrl) || browser.permissions.contains({ origins: [pattern] });
}


export function isNavigableUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function hasOptionalSiteAccess(): Promise<boolean> {
  return browser.permissions.contains({ origins: [...OPTIONAL_ORIGINS] });
}

export async function hasOriginAccess(rawUrl: string): Promise<boolean> {
  return hasExplicitAutomationOrigin(rawUrl);
}
export async function requestOriginAccess(rawUrl: string): Promise<boolean> {
  const pattern = originPatternForUrl(rawUrl);
  if (!pattern) return false;
  let origins = await readExplicitAutomationOrigins();
  if (origins.includes(pattern)) {
    if (isMeetingUrl(rawUrl) || await browser.permissions.contains({ origins: [pattern] })) return true;
    origins = origins.filter((origin) => origin !== pattern);
    await writeExplicitAutomationOrigins(origins);
  }
  if (origins.length >= MAX_EXPLICIT_AUTOMATION_ORIGINS) return false;
  if (!isMeetingUrl(rawUrl)) {
    const granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) return false;
  }
  origins.push(pattern);
  await writeExplicitAutomationOrigins(origins);
  return true;
}

export async function revokeOriginAccess(rawUrl: string): Promise<boolean> {
  const pattern = originPatternForUrl(rawUrl);
  if (!pattern) return false;
  const origins = await readExplicitAutomationOrigins();
  if (!origins.includes(pattern)) return false;
  if (!isMeetingUrl(rawUrl)) await browser.permissions.remove({ origins: [pattern] });
  await writeExplicitAutomationOrigins(origins.filter((origin) => origin !== pattern));
  return true;
}

export async function requestOptionalSiteAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: [...OPTIONAL_ORIGINS] });
}

export async function revokeOptionalSiteAccess(): Promise<boolean> {
  return browser.permissions.remove({ origins: [...OPTIONAL_ORIGINS] });
}

export async function canControlUrl(rawUrl: string): Promise<boolean> {
  return isNavigableUrl(rawUrl) && await hasExplicitAutomationOrigin(rawUrl);
}
export interface PermissionState {
  meetingHosts: true;
  optionalSiteAccess: boolean;
  currentOrigin?: string;
  currentOriginAccess: boolean;
}

export async function getPermissionState(currentUrl?: string): Promise<PermissionState> {
  const currentOrigin = currentUrl ? originPatternForUrl(currentUrl) ?? undefined : undefined;
  const optionalSiteAccess = await hasOptionalSiteAccess();
  const currentOriginAccess = currentUrl ? await hasExplicitAutomationOrigin(currentUrl) : false;
  return {
    meetingHosts: true,
    optionalSiteAccess,
    ...(currentOrigin ? { currentOrigin } : {}),
    currentOriginAccess,
  };
}
