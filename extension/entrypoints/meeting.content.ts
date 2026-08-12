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
    let checkAgain = false;

    const checkRoute = async (): Promise<void> => {
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        do {
          checkAgain = false;
          const route = parseMeetingUrl(location.href);
          const routeIdentity = meetingRouteIdentity(route);
          if (!route) {
            lastIdentity = routeIdentity;
            continue;
          }
          if (routeIdentity === lastIdentity) continue;
          const salt = await getOrCreateMeetingSalt({
            get: (keys) => browser.storage.local.get(keys),
            set: (values) => browser.storage.local.set(values),
          });
          const payload = await buildMeetingDetection(route, salt);
          lastIdentity = routeIdentity;
          await browser.runtime.sendMessage({ kind: 'meeting_detected_local', payload });
        } while (checkAgain);
      } finally {
        checking = false;
      }
    };

    const routeChanged = (): void => void checkRoute();
    await checkRoute();
    window.addEventListener('popstate', routeChanged);
    window.addEventListener('hashchange', routeChanged);
    window.addEventListener('pageshow', routeChanged);
    const navigationApi = (window as Window & { navigation?: EventTarget }).navigation;
    navigationApi?.addEventListener('navigatesuccess', routeChanged);
    const observer = new MutationObserver(routeChanged);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(routeChanged, 15_000);
  },
});

export type LocalMeetingMessage = {
  kind: 'meeting_detected_local';
  payload: MeetingDetection;
};
