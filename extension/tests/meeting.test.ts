import { describe, expect, it, vi } from 'vitest';
import {
  buildMeetingDetection,
  MeetingDeduper,
  opaqueMeetingKey,
  parseMeetingUrl,
  PENDING_MEETINGS_STORAGE_KEY,
  PendingMeetingQueue,
  type MeetingDeduperStore,
} from '../src/meeting';

const validZoomRoutes = [
  'https://zoom.us/j/123456789',
  'https://us02web.zoom.us/wc/join/123456789',
  'https://zoom.us/wc/123456789/join',
  'https://zoom.us/my/team-room',
];

describe('meeting route privacy', () => {
  it('accepts bounded Meet, Zoom meeting, and personal-link routes', () => {
    expect(parseMeetingUrl('https://meet.google.com/abc-defg-hij')).toEqual({ provider: 'google_meet', identity: 'meet:abc-defg-hij' });
    for (const url of validZoomRoutes) expect(parseMeetingUrl(url)?.provider).toBe('zoom');
  });

  it('rejects non-meeting routes, query-only IDs, and hostile lookalike hosts', () => {
    const rejected = [
      'https://zoom.us/my/',
      'https://zoom.us/my/a',
      'https://zoom.us/my/team-room/extra',
      'https://zoom.us/account/profile',
      'https://zoom.us/pricing',
      'https://zoom.us/j/123456789/extra',
      'https://zoom.us/join?confno=123456789',
      'http://zoom.us/j/123456789',
      'https://zoom.us.evil.example/j/123456789',
      'https://meet.google.com/abc-defg-hij/extra',
    ];
    for (const url of rejected) expect(parseMeetingUrl(url)).toBeNull();
  });

  it('clears the content-script identity when leaving a meeting route', async () => {
    vi.stubGlobal('defineContentScript', (config: unknown) => config);
    const { meetingRouteIdentity } = await import('../entrypoints/meeting.content');
    expect(meetingRouteIdentity({ provider: 'google_meet', identity: 'meet:abc-defg-hij' })).toBe('google_meet:meet:abc-defg-hij');
    expect(meetingRouteIdentity(null)).toBe('');
  });

  it('hashes locally and never places route identity in the detection payload', async () => {
    const route = parseMeetingUrl(validZoomRoutes[0]);
    if (!route) throw new Error('fixture route did not parse');
    const first = await buildMeetingDetection(route, 'a'.repeat(64), 1234);
    const second = await buildMeetingDetection(route, 'b'.repeat(64), 1234);
    expect(first.meeting_key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.meeting_key).not.toBe(second.meeting_key);
    expect(JSON.stringify(first)).not.toContain('123456789');
    expect(JSON.stringify(first)).not.toContain('zoom:');
    expect(await opaqueMeetingKey('a'.repeat(64), route.identity)).toBe(first.meeting_key);
  });

  it('deduplicates within TTL and suppresses detections while capture is active', () => {
    const deduper = new MeetingDeduper(100);
    const detection = { provider: 'zoom' as const, meeting_key: 'a'.repeat(64) };
    expect(deduper.accept(detection, 1_000)).toBe(true);
    expect(deduper.accept(detection, 1_050)).toBe(false);
    expect(deduper.accept(detection, 1_101)).toBe(true);
    deduper.setCaptureActive(true);
    expect(deduper.accept({ provider: 'google_meet', meeting_key: 'b'.repeat(64) }, 1_200)).toBe(false);
  });


  it('retains meeting events until positive delivery acknowledgement', async () => {
    const route = parseMeetingUrl(validZoomRoutes[0]);
    if (!route) throw new Error('fixture route did not parse');
    const now = Date.now();
    const first = await buildMeetingDetection(route, 'a'.repeat(64), now);
    const second = await buildMeetingDetection(route, 'a'.repeat(64), now + 1_000);
    const queue = new PendingMeetingQueue(1);
    queue.enqueue(first, now);
    queue.acknowledge(first.detection_id, false);
    expect(queue.values(now)).toEqual([first]);
    queue.enqueue(second, now + 1_000);
    expect(queue.values(now + 1_000)).toEqual([second]);
    queue.acknowledge(second.detection_id, true);
    expect(queue.size).toBe(0);
  });
});
describe('meeting session restart state', () => {
  it('restores deduplication expiry and capture-active state without route data', async () => {
    let state: Record<string, unknown> = {};
    const store: MeetingDeduperStore = {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]])),
      set: async (values) => {
        state = { ...state, ...values };
      },
    };
    const detection = { provider: 'zoom' as const, meeting_key: 'a'.repeat(64) };
    const first = new MeetingDeduper(100);
    expect(first.accept(detection, 1_000)).toBe(true);
    first.setCaptureActive(true);
    await first.persist(store, 1_000);

    const restored = new MeetingDeduper(100);
    await restored.restore(store, 1_050);
    expect(restored.accept(detection, 1_050)).toBe(false);
    restored.setCaptureActive(false);
    expect(restored.accept(detection, 1_050)).toBe(false);
    expect(restored.accept(detection, 1_101)).toBe(true);
    expect(JSON.stringify(state)).not.toContain('https://');
    expect(JSON.stringify(state)).not.toContain('title');
    expect(JSON.stringify(state)).not.toContain('content');
  });

  it('restores pending meetings and preserves negative acknowledgements', async () => {
    let state: Record<string, unknown> = {};
    const store: MeetingDeduperStore = {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]])),
      set: async (values) => {
        state = { ...state, ...values };
      },
    };
    const now = Date.now();
    const detection = {
      version: 1 as const,
      detection_id: 'det-1',
      provider: 'google_meet' as const,
      meeting_key: 'b'.repeat(64),
      detected_at_ms: now,
    };
    const first = new PendingMeetingQueue();
    first.enqueue(detection, now);
    await first.persist(store, now);
    expect(state[PENDING_MEETINGS_STORAGE_KEY]).toEqual({ version: 1, entries: [detection] });

    const restored = new PendingMeetingQueue();
    await restored.restore(store, now + 1_000);
    expect(restored.values(now + 1_000)).toEqual([detection]);
    restored.acknowledge(detection.detection_id, false);
    await restored.persist(store, now + 1_000);

    const afterNegativeAck = new PendingMeetingQueue();
    await afterNegativeAck.restore(store, now + 1_000);
    expect(afterNegativeAck.values(now + 1_000)).toEqual([detection]);
    afterNegativeAck.acknowledge(detection.detection_id, true);
    await afterNegativeAck.persist(store, now + 1_000);

    const afterPositiveAck = new PendingMeetingQueue();
    await afterPositiveAck.restore(store, now + 1_000);
    expect(afterPositiveAck.size).toBe(0);
    expect(JSON.stringify(state)).not.toContain('https://');
    expect(JSON.stringify(state)).not.toContain('title');
    expect(JSON.stringify(state)).not.toContain('content');
  });

  it('expires pending meetings and persists the pruned queue', async () => {
    let state: Record<string, unknown> = {};
    const store: MeetingDeduperStore = {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]])),
      set: async (values) => {
        state = { ...state, ...values };
      },
    };
    const detection = {
      version: 1 as const,
      detection_id: 'det-expired',
      provider: 'zoom' as const,
      meeting_key: 'c'.repeat(64),
      detected_at_ms: 1_000,
    };
    const queue = new PendingMeetingQueue();
    queue.enqueue(detection, 1_000);
    await queue.persist(store, 1_000);

    const restored = new PendingMeetingQueue();
    await restored.restore(store, 91_001);
    expect(restored.size).toBe(0);
    const persisted = state[PENDING_MEETINGS_STORAGE_KEY];
    if (!persisted || typeof persisted !== 'object' || !('entries' in persisted)) throw new Error('queue state was not persisted');
    expect(persisted.entries).toEqual([]);
  });
});
