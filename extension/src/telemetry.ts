export const TELEMETRY_ENDPOINT = 'https://analytics.libertydesign.studio/api/app-telemetry/event';
export const TELEMETRY_SCHEMA = 'lds.app-telemetry.event.v2';

export type TelemetryConsent = 'undecided' | 'accepted' | 'declined';
export type TelemetryPlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'web' | 'unknown';
export type TelemetryArchitecture = 'arm64' | 'x64' | 'x86' | 'unknown';
export type BrowserUsageCounter =
  | 'sessionsStarted'
  | 'sessionsEnded'
  | 'tabsOpened'
  | 'tabsClosed'
  | 'navigations'
  | 'screenshots'
  | 'meetingsDetected'
  | 'popupsHandled'
  | 'permissionsGranted'
  | 'permissionsDenied';

export const BROWSER_USAGE_COUNTERS: readonly BrowserUsageCounter[] = [
  'sessionsStarted',
  'sessionsEnded',
  'tabsOpened',
  'tabsClosed',
  'navigations',
  'screenshots',
  'meetingsDetected',
  'popupsHandled',
  'permissionsGranted',
  'permissionsDenied',
];

const CONSENT_KEY = 'overseer.telemetry.consent.v2';
const INSTALL_ID_KEY = 'overseer.telemetry.install-id.v2';
const HEARTBEAT_DAY_KEY = 'overseer.telemetry.heartbeat-day.v2';
const USAGE_DAY_KEY = 'overseer.telemetry.usage-day.v2';
const PENDING_USAGE_KEY = 'overseer.telemetry.pending-usage.v2';
const INFLIGHT_USAGE_KEY = 'overseer.telemetry.inflight-usage.v2';
const MAX_COUNTER_VALUE = 1_000_000;
const REQUEST_TIMEOUT_MS = 5_000;

export const TELEMETRY_STORAGE_KEYS = {
  consent: CONSENT_KEY,
  installId: INSTALL_ID_KEY,
  heartbeatDay: HEARTBEAT_DAY_KEY,
  usageDay: USAGE_DAY_KEY,
  pendingUsage: PENDING_USAGE_KEY,
  inFlightUsage: INFLIGHT_USAGE_KEY,
} as const;

export interface TelemetryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface TelemetryDependencies {
  storage: TelemetryStorage;
  fetcher: typeof fetch;
  now: () => Date;
  uuid: () => string;
  version: () => string;
  platform: () => TelemetryPlatform;
  arch: () => TelemetryArchitecture;
}

type UsageState = Partial<Record<BrowserUsageCounter, number>>;

type UsageBatch = {
  batchId: string;
  counters: UsageState;
};

type TelemetryEvent = 'launch' | 'heartbeat' | 'usage';

type TelemetryPayload = {
  schema: typeof TELEMETRY_SCHEMA;
  app: 'overseer-browser';
  event: TelemetryEvent;
  installId: string;
  version: string;
  platform: TelemetryPlatform;
  arch: TelemetryArchitecture;
  day: string;
  batchId?: string;
  usage?: UsageState;
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isUsageCounter(value: string): value is BrowserUsageCounter {
  return BROWSER_USAGE_COUNTERS.includes(value as BrowserUsageCounter);
}

function normalizedUsage(value: unknown): UsageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: UsageState = {};
  for (const [key, rawCount] of Object.entries(value)) {
    if (!isUsageCounter(key) || !Number.isSafeInteger(rawCount) || Number(rawCount) <= 0) continue;
    result[key] = Math.min(Number(rawCount), MAX_COUNTER_VALUE);
  }
  return result;
}

function isInstallId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBatchId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function normalizedUsageBatch(value: unknown): UsageBatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const batchId = candidate.batchId;
  const counters = normalizedUsage(candidate.counters);
  if (!isBatchId(batchId) || !hasUsage(counters)) return undefined;
  return { batchId, counters };
}

function usageIncrement(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_COUNTER_VALUE)
    : 0;
}

function hasUsage(value: UsageState): boolean {
  return Object.values(value).some((count) => typeof count === 'number' && count > 0);
}

export class BrowserTelemetry {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: TelemetryDependencies) {}

  getConsent(): Promise<TelemetryConsent> {
    return this.enqueue(async () => this.getConsentUnlocked());
  }

  setConsent(enabled: boolean): Promise<TelemetryConsent> {
    return this.enqueue(async () => {
      if (!enabled) {
        await this.dependencies.storage.remove([
          INSTALL_ID_KEY,
          HEARTBEAT_DAY_KEY,
          USAGE_DAY_KEY,
          PENDING_USAGE_KEY,
          INFLIGHT_USAGE_KEY,
        ]);
        await this.dependencies.storage.set({ [CONSENT_KEY]: 'declined' });
        return 'declined';
      }

      const state = await this.dependencies.storage.get([INSTALL_ID_KEY]);
      const storedInstallId = state[INSTALL_ID_KEY];
      const installId = isInstallId(storedInstallId) ? storedInstallId : this.dependencies.uuid();
      if (!isInstallId(installId)) throw new Error('Telemetry installation identifier could not be created.');
      await this.dependencies.storage.set({
        [CONSENT_KEY]: 'accepted',
        [INSTALL_ID_KEY]: installId,
      });
      await this.sendEventUnlocked('launch');
      await this.maybeSendDailyUnlocked();
      return 'accepted';
    });
  }

  recordUsage(counter: BrowserUsageCounter, amount = 1): Promise<void> {
    return this.enqueue(async () => {
      const increment = usageIncrement(amount);
      if (!isUsageCounter(counter) || increment === 0) return;
      if ((await this.getConsentUnlocked()) !== 'accepted') return;
      const state = await this.dependencies.storage.get([PENDING_USAGE_KEY]);
      const pending = normalizedUsage(state[PENDING_USAGE_KEY]);
      pending[counter] = Math.min(MAX_COUNTER_VALUE, (pending[counter] ?? 0) + increment);
      await this.dependencies.storage.set({ [PENDING_USAGE_KEY]: pending });
      await this.maybeSendDailyUnlocked();
    });
  }

  recordPermissionResult(granted: boolean): Promise<void> {
    return this.recordUsage(granted ? 'permissionsGranted' : 'permissionsDenied');
  }

  recordLaunch(): Promise<void> {
    return this.enqueue(async () => {
      if ((await this.getConsentUnlocked()) !== 'accepted') return;
      await this.sendEventUnlocked('launch');
      await this.maybeSendDailyUnlocked();
    });
  }

  maybeSendDaily(): Promise<void> {
    return this.enqueue(async () => this.maybeSendDailyUnlocked());
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async getConsentUnlocked(): Promise<TelemetryConsent> {
    const state = await this.dependencies.storage.get([CONSENT_KEY]);
    if (state[CONSENT_KEY] === 'accepted' || state[CONSENT_KEY] === 'declined') {
      return state[CONSENT_KEY];
    }
    return 'undecided';
  }

  private async maybeSendDailyUnlocked(): Promise<void> {
    if ((await this.getConsentUnlocked()) !== 'accepted') return;
    const day = utcDay(this.dependencies.now());
    const state = await this.dependencies.storage.get([
      HEARTBEAT_DAY_KEY,
      USAGE_DAY_KEY,
      PENDING_USAGE_KEY,
      INFLIGHT_USAGE_KEY,
    ]);

    if (state[HEARTBEAT_DAY_KEY] !== day && await this.sendEventUnlocked('heartbeat', undefined, day)) {
      await this.dependencies.storage.set({ [HEARTBEAT_DAY_KEY]: day });
    }

    const inFlight = normalizedUsageBatch(state[INFLIGHT_USAGE_KEY]);
    if (inFlight) {
      if (!await this.sendEventUnlocked('usage', inFlight.counters, day, inFlight.batchId)) return;
      // Keep the batch until the cadence marker is durable so storage failures retry idempotently.
      await this.dependencies.storage.set({ [USAGE_DAY_KEY]: day });
      await this.dependencies.storage.remove([INFLIGHT_USAGE_KEY]);
      return;
    }

    const pending = normalizedUsage(state[PENDING_USAGE_KEY]);
    if (state[USAGE_DAY_KEY] === day || !hasUsage(pending)) return;
    const batchId = this.dependencies.uuid();
    if (!isBatchId(batchId)) throw new Error('Telemetry usage batch identifier could not be created.');
    await this.dependencies.storage.set({
      [INFLIGHT_USAGE_KEY]: { batchId, counters: pending },
      [PENDING_USAGE_KEY]: {},
    });
    if (!await this.sendEventUnlocked('usage', pending, day, batchId)) return;
    await this.dependencies.storage.set({ [USAGE_DAY_KEY]: day });
    await this.dependencies.storage.remove([INFLIGHT_USAGE_KEY]);
  }

  private async sendEventUnlocked(
    event: TelemetryEvent,
    usage?: UsageState,
    day = utcDay(this.dependencies.now()),
    batchId?: string,
  ): Promise<boolean> {
    const state = await this.dependencies.storage.get([CONSENT_KEY, INSTALL_ID_KEY]);
    if (state[CONSENT_KEY] !== 'accepted' || !isInstallId(state[INSTALL_ID_KEY])) return false;

    const payload: TelemetryPayload = {
      schema: TELEMETRY_SCHEMA,
      app: 'overseer-browser',
      event,
      installId: state[INSTALL_ID_KEY],
      version: this.dependencies.version(),
      platform: this.dependencies.platform(),
      arch: this.dependencies.arch(),
      day,
    };
    if (event === 'usage') {
      if (!isBatchId(batchId)) return false;
      payload.batchId = batchId;
      payload.usage = normalizedUsage(usage);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.dependencies.fetcher(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function browserPlatform(): TelemetryPlatform {
  const platform = navigator.platform ?? '';
  if (/mac/i.test(platform)) return 'macos';
  if (/win/i.test(platform)) return 'windows';
  if (/linux/i.test(platform)) return 'linux';
  if (/iphone|ipad|ios/i.test(platform)) return 'ios';
  if (/android/i.test(platform)) return 'android';
  return 'unknown';
}

let instance: BrowserTelemetry | undefined;

export function browserTelemetry(): BrowserTelemetry {
  if (!instance) {
    instance = new BrowserTelemetry({
      storage: {
        get: (keys) => browser.storage.local.get(keys),
        set: (values) => browser.storage.local.set(values),
        remove: (keys) => browser.storage.local.remove(keys),
      },
      fetcher: fetch,
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
      version: () => browser.runtime.getManifest().version,
      platform: browserPlatform,
      arch: () => 'unknown',
    });
  }
  return instance;
}
