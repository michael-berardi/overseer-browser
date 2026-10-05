// Runs inside the Agent Window placeholder page (agent-window.html). Extension
// pages cannot be scripted with chrome.scripting, so the background asks this
// page for its viewport by message instead (mobile Agent Window fitting).
import { AGENT_WINDOW_VIEWPORT_MESSAGE } from './agent-window-protocol';

let windowId: number | undefined;
void chrome.windows.getCurrent().then((current) => {
  windowId = current.id;
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as { type?: string; windowId?: number } | null;
  // Every Agent Window page hears the broadcast; only the asked window answers.
  if (request?.type !== AGENT_WINDOW_VIEWPORT_MESSAGE || windowId === undefined || request.windowId !== windowId) return false;
  sendResponse({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 });
  return false;
});
