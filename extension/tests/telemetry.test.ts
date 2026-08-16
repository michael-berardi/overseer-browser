import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  BROWSER_USAGE_COUNTERS,
  BrowserTelemetry,
  TELEMETRY_ENDPOINT,
  TELEMETRY_SCHEMA,
  TELEMETRY_STORAGE_KEYS,
  type TelemetryDependencies,
  type TelemetryStorage,
} from '../src/telemetry';

class MemoryStorage implements TelemetryStorage {
  readonly values: Record<string, unknown> = {};

  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]));
  }

  async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) delete this.values[key];
  }
}

const installId = 'b56f7e8a-4d2c-4d6c-9d61-2f4a103e9b70';

function fixture(
  fetcher = vi.fn(async () => ({ ok: true } as Response)),
  uuid: () => string = () => installId,
) {
  const storage = new MemoryStorage();
  let now = new Date('2026-08-16T10:00:00Z');
  const dependencies: TelemetryDependencies = {
    storage,
    fetcher: fetcher as unknown as typeof fetch,
    now: () => now,
    uuid,
    version: () => '0.1.1',
    platform: () => 'macos',
    arch: () => 'unknown',
  };
  return {
    storage,
    fetcher,
    telemetry: new BrowserTelemetry(dependencies),
    setNow: (value: Date) => { now = value; },
  };
}

function payloads(fetcher: Mock): Array<Record<string, unknown>> {
  return fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
}

describe('browser telemetry consent and payloads', () => {
  it('keeps the exact allowlisted usage counters', () => {
    expect(BROWSER_USAGE_COUNTERS).toEqual([
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
    ]);
  });

  it('creates no identifier, counters, or network activity before opt-in', async () => {
    const { telemetry, storage, fetcher } = fixture();

    expect(await telemetry.getConsent()).toBe('undecided');
    await telemetry.recordUsage('sessionsStarted');
    await telemetry.maybeSendDaily();

    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.values).toEqual({});
  });

  it('persists decline without creating an installation identifier', async () => {
    const { telemetry, storage, fetcher } = fixture();

    expect(await telemetry.setConsent(false)).toBe('declined');
    await telemetry.recordLaunch();

    expect(storage.values).toEqual({ [TELEMETRY_STORAGE_KEYS.consent]: 'declined' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends only strict v2 launch and heartbeat fields after opt-in', async () => {
    const { telemetry, storage, fetcher } = fixture();

    expect(await telemetry.setConsent(true)).toBe('accepted');

    expect(storage.values[TELEMETRY_STORAGE_KEYS.installId]).toBe(installId);
    expect(payloads(fetcher)).toEqual([
      {
        schema: TELEMETRY_SCHEMA,
        app: 'overseer-browser',
        event: 'launch',
        installId,
        version: '0.1.1',
        platform: 'macos',
        arch: 'unknown',
        day: '2026-08-16',
      },
      {
        schema: TELEMETRY_SCHEMA,
        app: 'overseer-browser',
        event: 'heartbeat',
        installId,
        version: '0.1.1',
        platform: 'macos',
        arch: 'unknown',
        day: '2026-08-16',
      },
    ]);
    expect(fetcher.mock.calls.every((call) => call[0] === TELEMETRY_ENDPOINT)).toBe(true);
  });

  it('sends at most one usage batch per day and preserves later counters', async () => {
    const { telemetry, storage, fetcher, setNow } = fixture();
    await telemetry.setConsent(true);
    fetcher.mockClear();

    await telemetry.recordUsage('sessionsStarted');
    await telemetry.recordUsage('tabsOpened', 2);
    expect(payloads(fetcher)).toEqual([
      expect.objectContaining({ event: 'usage', batchId: installId, usage: { sessionsStarted: 1 } }),
    ]);
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({ tabsOpened: 2 });

    setNow(new Date('2026-08-17T00:05:00Z'));
    await telemetry.maybeSendDaily();
    expect(payloads(fetcher)).toEqual([
      expect.objectContaining({ event: 'usage', batchId: installId, usage: { sessionsStarted: 1 } }),
      expect.objectContaining({ event: 'heartbeat', day: '2026-08-17' }),
      expect.objectContaining({ event: 'usage', day: '2026-08-17', batchId: installId, usage: { tabsOpened: 2 } }),
    ]);
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({});
  });

  it('retries an immutable usage batch across failures and UTC rollover', async () => {
    let failUsage = false;
    const firstBatchId = '11111111-1111-4111-8111-111111111111';
    const secondBatchId = '22222222-2222-4222-8222-222222222222';
    let currentBatchId = firstBatchId;
    let uuidCalls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { event: string };
      return { ok: !(failUsage && payload.event === 'usage') } as Response;
    });
    const { telemetry, storage, setNow } = fixture(fetcher, () => uuidCalls++ === 0 ? installId : currentBatchId);
    await telemetry.setConsent(true);
    fetcher.mockClear();

    failUsage = true;
    await telemetry.recordUsage('screenshots', 3);
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({});
    expect(storage.values[TELEMETRY_STORAGE_KEYS.inFlightUsage]).toEqual({
      batchId: firstBatchId,
      counters: { screenshots: 3 },
    });
    await telemetry.recordUsage('tabsOpened', 2);
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({ tabsOpened: 2 });
    setNow(new Date('2026-08-17T00:05:00Z'));
    await telemetry.maybeSendDaily();
    const rolloverUsage = payloads(fetcher).filter((payload) => payload.event === 'usage');
    expect(rolloverUsage).toHaveLength(3);
    expect(rolloverUsage[0]).toMatchObject({ batchId: firstBatchId, day: '2026-08-16', usage: { screenshots: 3 } });
    expect(rolloverUsage[1]).toMatchObject({ batchId: firstBatchId, day: '2026-08-16', usage: { screenshots: 3 } });
    expect(rolloverUsage[2]).toMatchObject({ batchId: firstBatchId, day: '2026-08-17', usage: { screenshots: 3 } });

    failUsage = false;
    await telemetry.maybeSendDaily();
    const usage = payloads(fetcher).filter((payload) => payload.event === 'usage');
    expect(usage).toHaveLength(4);
    expect(usage[3]).toMatchObject({ batchId: firstBatchId, day: '2026-08-17', usage: { screenshots: 3 } });
    expect(storage.values[TELEMETRY_STORAGE_KEYS.inFlightUsage]).toBeUndefined();
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({ tabsOpened: 2 });

    setNow(new Date('2026-08-18T00:05:00Z'));
    currentBatchId = secondBatchId;
    await telemetry.maybeSendDaily();
    const nextUsage = payloads(fetcher).filter((payload) => payload.event === 'usage');
    expect(nextUsage[nextUsage.length - 1]).toMatchObject({ batchId: secondBatchId, day: '2026-08-18', usage: { tabsOpened: 2 } });
    expect(storage.values[TELEMETRY_STORAGE_KEYS.pendingUsage]).toEqual({});
  });

  it('deletes the identifier, cadence, and pending counters when disabled', async () => {
    const { telemetry, storage } = fixture();
    await telemetry.setConsent(true);
    await telemetry.recordUsage('tabsClosed');
    await telemetry.recordUsage('navigations');

    storage.values[TELEMETRY_STORAGE_KEYS.inFlightUsage] = {
      batchId: '11111111-1111-4111-8111-111111111111',
      counters: { tabsClosed: 1 },
    };
    expect(await telemetry.setConsent(false)).toBe('declined');

    expect(storage.values).toEqual({ [TELEMETRY_STORAGE_KEYS.consent]: 'declined' });
  });

  it('replaces malformed identifiers and ignores invalid counter increments', async () => {
    const { telemetry, storage, fetcher } = fixture();
    storage.values[TELEMETRY_STORAGE_KEYS.installId] = 'aaaaaaaa-aaaa-1aaa-7aaa-aaaaaaaaaaaa';

    await telemetry.setConsent(true);
    fetcher.mockClear();
    await telemetry.recordUsage('tabsOpened', 1.5);
    await telemetry.recordUsage('tabsOpened', Number.POSITIVE_INFINITY);
    await telemetry.recordUsage('tabsOpened', 2);

    expect(storage.values[TELEMETRY_STORAGE_KEYS.installId]).toBe(installId);
    expect(payloads(fetcher)).toEqual([
      expect.objectContaining({ event: 'usage', batchId: installId, usage: { tabsOpened: 2 } }),
    ]);
  });
});
