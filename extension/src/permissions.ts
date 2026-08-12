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

export const OPTIONAL_ORIGINS = ['http://*/*', 'https://*/*'] as const;

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

function isValidMeetingOriginPattern(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_PATTERN_LENGTH || !value.endsWith('/*')) return false;
  try {
    const url = new URL(value.slice(0, -2));
    return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash &&
      isMeetingUrl(`${url.origin}/`);
  } catch {
    return false;
  }
}

async function readExplicitAutomationOrigins(): Promise<string[]> {
  const stored = (await browser.storage.local.get([EXPLICIT_AUTOMATION_ORIGINS_KEY]))[EXPLICIT_AUTOMATION_ORIGINS_KEY];
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter(isValidMeetingOriginPattern))].slice(0, MAX_EXPLICIT_AUTOMATION_ORIGINS);
}

async function writeExplicitAutomationOrigins(origins: string[]): Promise<void> {
  const valid = [...new Set(origins.filter(isValidMeetingOriginPattern))].slice(0, MAX_EXPLICIT_AUTOMATION_ORIGINS);
  await browser.storage.local.set({ [EXPLICIT_AUTOMATION_ORIGINS_KEY]: valid });
}

async function hasExplicitAutomationOrigin(rawUrl: string): Promise<boolean> {
  const pattern = originPatternForUrl(rawUrl);
  return isMeetingUrl(rawUrl) && pattern !== null && (await readExplicitAutomationOrigins()).includes(pattern);
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
  const pattern = originPatternForUrl(rawUrl);
  return pattern ? browser.permissions.contains({ origins: [pattern] }) : false;
}
export async function requestOriginAccess(rawUrl: string): Promise<boolean> {
  const pattern = originPatternForUrl(rawUrl);
  if (!pattern) return false;
  if (isMeetingUrl(rawUrl)) {
    const origins = await readExplicitAutomationOrigins();
    if (origins.includes(pattern)) return true;
    if (origins.length >= MAX_EXPLICIT_AUTOMATION_ORIGINS) return false;
    origins.push(pattern);
    await writeExplicitAutomationOrigins(origins);
    return true;
  }
  return browser.permissions.request({ origins: [pattern] });
}

export async function revokeOriginAccess(rawUrl: string): Promise<boolean> {
  const pattern = originPatternForUrl(rawUrl);
  if (!pattern) return false;
  if (isMeetingUrl(rawUrl)) {
    const origins = await readExplicitAutomationOrigins();
    if (!origins.includes(pattern)) return false;
    await writeExplicitAutomationOrigins(origins.filter((origin) => origin !== pattern));
    return true;
  }
  return browser.permissions.remove({ origins: [pattern] });
}

export async function requestOptionalSiteAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: [...OPTIONAL_ORIGINS] });
}

export async function canControlUrl(rawUrl: string): Promise<boolean> {
  if (!isNavigableUrl(rawUrl)) return false;
  if (await hasOptionalSiteAccess()) return true;
  if (isMeetingUrl(rawUrl)) return hasExplicitAutomationOrigin(rawUrl);
  return hasOriginAccess(rawUrl);
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
  const currentOriginAccess = optionalSiteAccess || (currentUrl
    ? isMeetingUrl(currentUrl) ? await hasExplicitAutomationOrigin(currentUrl) : await hasOriginAccess(currentUrl)
    : false);
  return {
    meetingHosts: true,
    optionalSiteAccess,
    ...(currentOrigin ? { currentOrigin } : {}),
    currentOriginAccess,
  };
}
