import { buildMeetingDetection, getOrCreateMeetingSalt, parseMeetingUrl } from '../src/meeting';
import type { MeetingDetection } from '../src/protocol';

export function meetingRouteIdentity(route: { provider: string; identity: string } | null): string {
  return route ? `${route.provider}:${route.identity}` : '';
}

export default defineContentScript({
  matches: ['https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*'],
  allFrames: false,
  runAt: 'document_idle',
  async main() {
    let lastIdentity = '';
    let checking = false;

    const checkRoute = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const route = parseMeetingUrl(location.href);
        const routeIdentity = meetingRouteIdentity(route);
        if (!route) {
          lastIdentity = routeIdentity;
          return;
        }
        if (routeIdentity === lastIdentity) return;
        const salt = await getOrCreateMeetingSalt({
          get: (keys) => browser.storage.local.get(keys),
          set: (values) => browser.storage.local.set(values),
        });
        const payload = await buildMeetingDetection(route, salt);
        lastIdentity = routeIdentity;
        await browser.runtime.sendMessage({ kind: 'meeting_detected_local', payload });
      } finally {
        checking = false;
      }
    };

    await checkRoute();
    window.addEventListener('popstate', () => void checkRoute());
    window.addEventListener('hashchange', () => void checkRoute());
    window.setInterval(() => void checkRoute(), 15_000);
  },
});

export type LocalMeetingMessage = {
  kind: 'meeting_detected_local';
  payload: MeetingDetection;
};
