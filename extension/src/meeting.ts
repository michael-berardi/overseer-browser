import { isMeetingDetection, type MeetingDetection, type Provider } from './protocol';

const SALT_STORAGE_KEY = 'overseer.meetingSalt.v1';
export const MEETING_DEDUP_STORAGE_KEY = 'overseer.meetingDeduper.v1';
export const PENDING_MEETINGS_STORAGE_KEY = 'overseer.pendingMeetings.v1';
export const MEETING_DEDUP_TTL_MS = 90_000;
export const MEETING_DEDUP_MAX_ENTRIES = 128;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ZOOM_MEETING_ID = /^[0-9]{6,14}$/;
const ZOOM_PERSONAL_SLUG = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
export interface MeetingRoute {
  provider: Provider;
  identity: string;
}

export interface SaltStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function parseMeetingUrl(input: string): MeetingRoute | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'meet.google.com') {
    const code = segments[0]?.toLowerCase();
    if (segments.length === 1 && code && MEET_CODE.test(code)) return { provider: 'google_meet', identity: `meet:${code}` };
    return null;
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    let meetingId: string | undefined;
    if (segments.length === 2 && segments[0]?.toLowerCase() === 'j') meetingId = segments[1];
    if (segments.length === 3 && segments[0]?.toLowerCase() === 'wc' && segments[1]?.toLowerCase() === 'join') meetingId = segments[2];
    if (segments.length === 3 && segments[0]?.toLowerCase() === 'wc' && segments[2]?.toLowerCase() === 'join') meetingId = segments[1];
    if (meetingId && ZOOM_MEETING_ID.test(meetingId)) return { provider: 'zoom', identity: `zoom:${meetingId}` };
    if (segments.length === 2 && segments[0]?.toLowerCase() === 'my') {
      const slug = segments[1]?.toLowerCase();
      if (slug && ZOOM_PERSONAL_SLUG.test(slug)) return { provider: 'zoom', identity: `zoom:${slug}` };
    }
  }
  return null;
}

export async function getOrCreateMeetingSalt(store: SaltStore): Promise<string> {
  const existing = (await store.get([SALT_STORAGE_KEY]))[SALT_STORAGE_KEY];
  if (typeof existing === 'string' && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const salt = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await store.set({ [SALT_STORAGE_KEY]: salt });
  return salt;
}

export async function opaqueMeetingKey(salt: string, identity: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}\u0000${identity}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildMeetingDetection(
  route: MeetingRoute,
  salt: string,
  detectedAtMs = Date.now(),
): Promise<MeetingDetection> {
  return {
    version: 1,
    detection_id: crypto.randomUUID(),
    provider: route.provider,
    meeting_key: await opaqueMeetingKey(salt, route.identity),
    detected_at_ms: detectedAtMs,
  };
}

export const PENDING_MEETINGS_MAX_ENTRIES = 32;

export interface MeetingDeduperStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface PersistedMeetingDeduperState {
  version: 1;
  capture_active: boolean;
  entries: Array<{ key: string; expires_at_ms: number }>;
}

export interface PersistedPendingMeetingsState {
  version: 1;
  entries: MeetingDetection[];
}

export class PendingMeetingQueue {
  private readonly pending = new Map<string, MeetingDetection>();

  constructor(
    private readonly maximum = PENDING_MEETINGS_MAX_ENTRIES,
    private readonly ttlMs = MEETING_DEDUP_TTL_MS,
  ) {}

  enqueue(detection: MeetingDetection, now = Date.now()): void {
    this.prune(now);
    if (detection.detected_at_ms <= now - this.ttlMs) return;
    if (!this.pending.has(detection.detection_id) && this.pending.size >= this.maximum) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(detection.detection_id, detection);
  }

  acknowledge(detectionId: string, delivered: boolean): void {
    if (delivered) this.pending.delete(detectionId);
  }

  async restore(store: MeetingDeduperStore, now = Date.now()): Promise<void> {
    this.pending.clear();
    const values = await store.get([PENDING_MEETINGS_STORAGE_KEY]);
    const candidate = values[PENDING_MEETINGS_STORAGE_KEY];
    if (candidate && typeof candidate === 'object') {
      const state = candidate as Partial<PersistedPendingMeetingsState>;
      if (state.version === 1 && Array.isArray(state.entries)) {
        for (const entry of state.entries) {
          if (isMeetingDetection(entry)) this.enqueue(entry, now);
        }
      }
    }
    await this.persist(store, now);
  }

  async persist(store: MeetingDeduperStore, now = Date.now()): Promise<void> {
    const state: PersistedPendingMeetingsState = {
      version: 1,
      entries: this.values(now).map(({ version, detection_id, provider, meeting_key, detected_at_ms }) => ({
        version,
        detection_id,
        provider,
        meeting_key,
        detected_at_ms,
      })),
    };
    await store.set({ [PENDING_MEETINGS_STORAGE_KEY]: state });
  }

  values(now = Date.now()): MeetingDetection[] {
    this.prune(now);
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }

  private prune(now: number): void {
    for (const [detectionId, detection] of this.pending) {
      if (detection.detected_at_ms <= now - this.ttlMs) this.pending.delete(detectionId);
    }
  }
}

export class MeetingDeduper {
  private readonly seen = new Map<string, number>();
  private captureActive = false;

  constructor(
    private readonly ttlMs = MEETING_DEDUP_TTL_MS,
    private readonly maximum = MEETING_DEDUP_MAX_ENTRIES,
  ) {}

  setCaptureActive(active: boolean): void {
    this.captureActive = active;
  }

  async restore(store: MeetingDeduperStore, now = Date.now()): Promise<void> {
    this.seen.clear();
    this.captureActive = false;
    const values = await store.get([MEETING_DEDUP_STORAGE_KEY]);
    const candidate = values[MEETING_DEDUP_STORAGE_KEY];
    if (candidate && typeof candidate === 'object') {
      const state = candidate as Partial<PersistedMeetingDeduperState>;
      if (state.version === 1) {
        if (typeof state.capture_active === 'boolean') this.captureActive = state.capture_active;
        if (Array.isArray(state.entries)) {
          for (const entry of state.entries) {
            if (
              !entry ||
              typeof entry !== 'object' ||
              typeof entry.key !== 'string' ||
              entry.key.length > 192 ||
              typeof entry.expires_at_ms !== 'number' ||
              !Number.isFinite(entry.expires_at_ms) ||
              entry.expires_at_ms <= now
            ) continue;
            if (!this.seen.has(entry.key) && this.seen.size >= this.maximum) {
              const oldest = this.seen.keys().next().value;
              if (oldest !== undefined) this.seen.delete(oldest);
            }
            this.seen.set(entry.key, entry.expires_at_ms);
          }
        }
      }
    }
    await this.persist(store, now);
  }

  async persist(store: MeetingDeduperStore, now = Date.now()): Promise<void> {
    this.prune(now);
    const state: PersistedMeetingDeduperState = {
      version: 1,
      capture_active: this.captureActive,
      entries: [...this.seen].map(([key, expires_at_ms]) => ({ key, expires_at_ms })),
    };
    await store.set({ [MEETING_DEDUP_STORAGE_KEY]: state });
  }

  accept(detection: Pick<MeetingDetection, 'provider' | 'meeting_key'>, now = Date.now()): boolean {
    this.prune(now);
    if (this.captureActive) return false;
    const key = `${detection.provider}:${detection.meeting_key}`;
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > now) return false;
    if (this.seen.size >= this.maximum) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
  }
}
