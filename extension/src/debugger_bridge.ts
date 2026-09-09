/** No persisted grants, arbitrary CDP, response bodies or network mutation. */
export const DEBUGGER_INSTRUCTIONS = 'Open the extension popup on the session-selected HTTP(S) tab. An approved debugger-enabled build is required (Chrome does not support optional debugger permission). Explicitly authorize only that tab. Consent expires after 5 minutes or navigation; Chrome may show a debugging banner. DevTools can disconnect it.';
const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
type Grant = { session: string; tabId: number; origin: string; valid: boolean; attached: boolean; network: boolean; logs: unknown[]; tail: Promise<unknown>; timer?: ReturnType<typeof setTimeout> };
export function debuggerOrigin(url?: string): string {
  const u = new URL(url ?? '');
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Debugger requires an HTTP(S) page.');
  return u.origin;
}
export function trustedDebuggerPopup(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html') && !sender.tab;
}
export function redactDebuggerEvent(method: string, raw: unknown): unknown | undefined {
  if (!['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) return;
  const p = raw as Record<string, any> | undefined;
  if (!p || typeof p.requestId !== 'string') return;
  const item = p.request ?? p.response;
  const headers: Record<string, string> = {};
  // All values and non-allowlisted names are removed, including cookies/auth.
  for (const name of ['content-type', 'content-length', 'cache-control']) {
    if (item?.headers && Object.keys(item.headers).some(k => k.toLowerCase() === name)) headers[name] = '[redacted]';
  }
  let origin: string | undefined;
  try { if (item?.url) origin = debuggerOrigin(item.url); } catch { origin = '[redacted]'; }
  return { event: method.slice(8), request_id: p.requestId.slice(0, 80), origin, headers,
    status: Number.isFinite(item?.status) ? item.status : undefined,
    timestamp: Number.isFinite(p.timestamp) ? p.timestamp : undefined,
    bytes: Number.isFinite(p.encodedDataLength) ? p.encodedDataLength : undefined };
}
export class DebuggerBridge {
  private grants = new Map<number, Grant>();
  private pending = new Map<number, object>();
  constructor(private owns: (session: string, tabId: number) => Promise<boolean>, private enabled = false) {}
  listen(): void {
    if (!this.enabled || !chrome.debugger) return;
    chrome.tabs.onUpdated.addListener((id, info) => { if (info.url !== undefined || info.status === 'loading') void this.revoke(id); });
    chrome.tabs.onRemoved.addListener(id => { void this.revoke(id); });
    chrome.permissions.onRemoved.addListener(p => { if (p.permissions?.includes('debugger')) void this.revokeAll(); });
    chrome.debugger.onDetach.addListener(source => {
      const g = source.tabId === undefined ? undefined : this.grants.get(source.tabId);
      if (g) { g.attached = false; void this.revoke(g.tabId); }
    });
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const g = source.tabId === undefined || source.sessionId ? undefined : this.grants.get(source.tabId);
      if (!g?.valid || !g.attached || !g.network) return;
      const event = redactDebuggerEvent(method, params);
      if (event) { g.logs.push(event); if (g.logs.length > 200) g.logs.shift(); }
    });
  }
  async status(session: string, tabId: number) {
    if (!await this.owns(session, tabId)) throw new Error('Tab is not owned by this session.');
    const tab = await chrome.tabs.get(tabId);
    let origin: string | undefined;
    try { origin = debuggerOrigin(tab.url); } catch { /* unsupported */ }
    const g = this.grants.get(tabId);
    const permission = this.enabled && await chrome.permissions.contains({ permissions: ['debugger'] });
    const authorized = !!g?.valid && g.session === session && g.origin === origin && permission;
    if (g && !authorized) await this.revoke(tabId);
    return { available: this.enabled, tab_id: tabId, session_key: session, origin, permission, authorized, attached: authorized && g!.attached, network: authorized && g!.network, instructions: DEBUGGER_INSTRUCTIONS, response_bodies: false };
  }
  async authorize(session: string, tabId: number, origin: string): Promise<void> {
    if (!this.enabled) throw new Error('Debugger installation permission is not enabled; separate operator approval is required.');
    // Caller MUST be the exact trusted popup; no native command reaches this method.
    const cleanup = this.revoke(tabId);
    const token = {};
    this.pending.set(tabId, token);
    try {
      await cleanup;
      if (!await chrome.permissions.contains({ permissions: ['debugger'] }) || !await this.owns(session, tabId)) throw new Error('Permission and session ownership required.');
      const tab = await chrome.tabs.get(tabId);
      if (this.pending.get(tabId) !== token || tab.pendingUrl || debuggerOrigin(tab.url) !== origin) throw new Error('Tab changed; review it again.');
      const g: Grant = { session, tabId, origin, valid: true, attached: false, network: false, logs: [], tail: Promise.resolve() };
      this.grants.set(tabId, g);
      g.timer = setTimeout(() => { void this.revoke(tabId); }, 300_000);
    } finally { if (this.pending.get(tabId) === token) this.pending.delete(tabId); }
  }

  async revoke(tabId: number): Promise<void> {
    this.pending.delete(tabId);
    const g = this.grants.get(tabId);
    if (!g) return;
    g.valid = false; g.network = false; g.logs = []; clearTimeout(g.timer);
    await g.tail.catch(() => {});
    if (g.attached) {
      // Only detach attachments successfully made by this instance, never DevTools.
      g.attached = false;
      try { await chrome.debugger.detach({ tabId }); } catch { /* already detached or permission removed */ }
      g.attached = false;
    }
    if (this.grants.get(tabId) === g) this.grants.delete(tabId);
  }
  async revokeAll(): Promise<void> { this.pending.clear(); await Promise.all([...this.grants.keys()].map(id => this.revoke(id))); }
  private async check(g: Grant): Promise<void> {
    if (!g.valid || this.grants.get(g.tabId) !== g || !await this.owns(g.session, g.tabId) || !await chrome.permissions.contains({ permissions: ['debugger'] })) throw new Error(DEBUGGER_INSTRUCTIONS);
    const tab = await chrome.tabs.get(g.tabId);
    if (!g.valid || tab.pendingUrl || debuggerOrigin(tab.url) !== g.origin) throw new Error('Target changed; authorize again in popup.');
  }
  async command(session: string, tabId: number, command: string, p: Record<string, unknown>, guard: () => void = () => {}): Promise<unknown> {
    const allowed = command === 'debugger.input' ? ['tab_id', 'op', ...(p.op === 'click' ? ['x', 'y'] : p.op === 'key' ? ['key'] : p.op === 'text' ? ['text'] : [])] : command === 'debugger.network' ? ['tab_id', 'action'] : ['tab_id'];
    if (Object.keys(p).some(k => !allowed.includes(k))) throw new Error('Unsupported debugger parameter.');
    if (command === 'debugger.status') return this.status(session, tabId);
    if (command === 'debugger.input' && !(p.op === 'click' && typeof p.x === 'number' && Number.isFinite(p.x) && p.x >= 0 && p.x < 100_000 && typeof p.y === 'number' && Number.isFinite(p.y) && p.y >= 0 && p.y < 100_000 || p.op === 'key' && typeof p.key === 'string' && KEYS.includes(p.key) || p.op === 'text' && typeof p.text === 'string' && p.text.length <= 4096)) throw new Error('Invalid bounded debugger input.');
    if (command === 'debugger.network' && !['start', 'stop', 'logs', 'status'].includes(String(p.action))) throw new Error('Invalid debugger network action.');
    if (!['debugger.input', 'debugger.network'].includes(command)) throw new Error('Unsupported debugger command.');
    const g = this.grants.get(tabId);
    if (!g || g.session !== session || !g.valid) throw new Error(DEBUGGER_INSTRUCTIONS);
    const work = g.tail.then(async () => {
      const send = async (method: string, params?: Record<string, unknown>) => { guard(); await this.check(g); guard(); return chrome.debugger.sendCommand({ tabId }, method, params); };
      try {
        guard(); await this.check(g);
        if (command === 'debugger.network' && ['logs', 'status'].includes(String(p.action))) return { active: g.network, entries: p.action === 'logs' ? [...g.logs] : undefined, response_bodies: false, warning: 'Bounded metadata only; all header values and URL paths/query removed.' };
        if (command === 'debugger.network' && p.action === 'stop') { if (g.network) await send('Network.disable'); g.network = false; g.logs = []; return { active: false }; }
        if (!g.attached) {
          const targets = await chrome.debugger.getTargets();
          const target = targets.find(t => t.tabId === tabId);
          if (!target || target.type !== 'page' || target.attached) throw new Error('Target unavailable or already debugged; close DevTools yourself and reauthorize.');
          await this.check(g); guard();
          await chrome.debugger.attach({ tabId }, '1.3');
          g.attached = true;
          await this.check(g);
        }
        if (command === 'debugger.network') {
          await send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
          g.network = true;
          return { active: true, response_bodies: false, warning: 'Metadata only, at most 200 events. Sensitive header values and URL paths/query removed.' };
        }
        {
          // Isolated top-frame check rejects nested browser/extension/iframe targets.
          const [probe] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: (x: number, y: number, origin: string, click: boolean) => {
            let el = click ? document.elementFromPoint(x, y) : document.activeElement;
            while (el?.shadowRoot) {
              const child = click ? el.shadowRoot.elementFromPoint(x, y) : el.shadowRoot.activeElement;
              if (!child || child === el) break;
              el = child;
            }
            return location.origin === origin && (!click || x < innerWidth && y < innerHeight) && !!el && !['IFRAME', 'FRAME', 'OBJECT', 'EMBED'].includes(el.tagName);
          }, args: [p.op === 'click' ? p.x as number : 0, p.op === 'click' ? p.y as number : 0, g.origin, p.op === 'click'] });
          if (probe?.result !== true) throw new Error('Click is outside the viewport or targets an unsupported nested frame.');
        }
        if (p.op === 'click') {
          const metrics = await send('Page.getLayoutMetrics') as { cssVisualViewport?: { clientWidth: number; clientHeight: number } };
          const viewport = metrics.cssVisualViewport;
          if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) || (p.x as number) >= viewport.clientWidth || (p.y as number) >= viewport.clientHeight) throw new Error('Viewport bounds changed or unavailable.');
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        } else if (p.op === 'key') {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: p.key });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: p.key });
        } else await send('Input.insertText', { text: p.text });
        return { dispatched: true, warning: 'Trusted browser input dispatched; page outcome is not guaranteed.' };
      } catch (e) {
        g.valid = false; g.network = false; g.logs = []; clearTimeout(g.timer);
        if (g.attached) { g.attached = false; try { await chrome.debugger.detach({ tabId }); } catch {} }
        if (this.grants.get(tabId) === g) this.grants.delete(tabId);
        throw e;
      }
    });
    g.tail = work.catch(() => {});
    return work;
  }
}
