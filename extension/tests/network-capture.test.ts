import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function event() {
  const listeners = new Set<Listener>();
  return {
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    emit: (...args: unknown[]) => listeners.forEach((listener) => listener(...args)),
  };
}

function storageArea(store: Record<string, unknown>) {
  return {
    get: async (keys: string[] | null) => Object.fromEntries((keys ?? Object.keys(store)).filter((key) => key in store).map((key) => [key, store[key]])),
    set: async (values: Record<string, unknown>) => Object.assign(store, values),
    remove: async (key: string) => delete store[key],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Load the background module with inert Chrome globals and capture the injected beacon function. */
async function injectedNetworkFunction(): Promise<{ run: (...args: unknown[]) => any; args: unknown[] }> {
  const injections: Array<{ func: (...args: unknown[]) => any; args?: unknown[] }> = [];
  const browserStub = {
    storage: {
      local: storageArea({ 'overseer.connection.enabled.v1': false, 'overseer.site.unlimited.v2': true }),
      session: storageArea({}),
    },
    tabs: { onUpdated: event(), onRemoved: event(), get: vi.fn(), query: vi.fn(async () => []) },
    runtime: { onMessage: event(), connectNative: vi.fn(), getURL: (path: string) => path, getManifest: () => ({ version: '0.10.16' }) },
    windows: { get: vi.fn(), create: vi.fn() },
    scripting: {
      executeScript: vi.fn(async (injection: { func: (...args: unknown[]) => any; args?: unknown[] }) => {
        injections.push(injection);
        return [{ result: undefined }];
      }),
    },
    permissions: { contains: vi.fn(async () => true), remove: vi.fn(async () => true), request: vi.fn(async () => true) },
    userScripts: { getScripts: vi.fn(async () => []) },
  };
  vi.stubGlobal('browser', browserStub);
  vi.stubGlobal('chrome', browserStub);
  vi.stubGlobal('defineBackground', (callback: () => void) => callback());
  vi.resetModules();
  const { runNetworkCommand } = await import('../entrypoints/background');
  await runNetworkCommand(7, 'network.start');
  expect(injections).toHaveLength(1);
  const injectionArgs = injections[0]!.args ?? [];
  return { run: injections[0]!.func, args: injectionArgs.slice(1) };
}

describe('bounded sendBeacon capture', () => {
  it('records only redacted metadata, forwards the beacon, and restores the page function', async () => {
    const { run, args } = await injectedNetworkFunction();
    const sent: unknown[] = [];
    const original = ((...values: unknown[]) => { sent.push(values); return true; }) as typeof navigator.sendBeacon;
    const nav = { sendBeacon: original };
    vi.stubGlobal('navigator', nav);
    vi.stubGlobal('location', { href: 'https://example.test/guides' });

    expect(run('network.start', ...args)).toMatchObject({ installed: true });
    const wrapper = nav.sendBeacon;
    expect(wrapper).not.toBe(original);
    expect(wrapper('https://example.test/api/network/observability/client-event?kind=ad_impression', JSON.stringify({ zone: 'listing-feature' }))).toBe(true);
    expect(sent).toHaveLength(1);

    const result = run('network.read', ...args) as { beacons: Array<Record<string, unknown>>; installed: boolean };
    expect(result.installed).toBe(true);
    expect(result.beacons).toHaveLength(1);
    expect(result.beacons[0]).toMatchObject({
      kind: 'beacon',
      method: 'POST',
      url: 'https://example.test/api/network/observability/client-event',
      content_type: 'text/plain;charset=UTF-8',
      source: 'navigator.sendBeacon',
    });
    expect(result.beacons[0]!.body_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(result.beacons[0])).not.toContain('kind=ad_impression');

    run('network.stop', ...args);
    expect(nav.sendBeacon).toBe(original);
  });
});
