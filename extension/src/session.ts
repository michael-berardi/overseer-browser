import { isNavigableUrl } from './permissions';
import { AGENT_WINDOW_VIEWPORT_MESSAGE } from './agent-window-protocol';

export const SESSION_STORAGE_KEY = 'overseer.session.v1';
export const SESSION_STORAGE_PREFIX = 'overseer.session.v2.';

export const MOBILE_VIEWPORT_DEFAULT = { width: 375, height: 812 } as const;
const MOBILE_WIDTH_RANGE = [200, 1000] as const;
const MOBILE_HEIGHT_RANGE = [200, 3000] as const;
/** Window sizes come back in whole pixels; display scaling can shift them by a pixel or two. */
const SIZE_TOLERANCE_PX = 2;
const VIEWPORT_READ_ATTEMPTS = 15;
const VIEWPORT_READ_DELAY_MS = 100;

/** Requested page viewport (CSS pixels) of a mobile Agent Window. */
export interface MobileWindowRequest {
  width: number;
  height: number;
}

/** What the page itself reports: window.innerWidth/innerHeight and devicePixelRatio. */
export interface ViewportReadback {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface SessionState {
  sessionId: string;
  sessionKey?: string;
  agentWindowId: number;
  mobile?: MobileWindowRequest;
  ownedTabIds: number[];
  borrowedTabIds: number[];
  name?: string;
  selectedTabId?: number;
  paused?: boolean;
  startedAtMs: number;
}

export interface SessionSummary extends SessionState {
  connected: boolean;
}

export type SessionReleaseHook = (tabId: number) => Promise<void>;

export class SessionManager {
  private state: SessionState | null = null;
  private loadPromise: Promise<void> | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private refreshPromise: Promise<Browser.tabs.Tab[]> | null = null;

  private readonly storageKey: string;

  constructor(
    private readonly releaseHook?: SessionReleaseHook,
    readonly sessionKey = 'default',
    private readonly assertTabAvailable?: (tabId: number) => Promise<void>,
  ) {
    this.storageKey = sessionKey === 'default' ? SESSION_STORAGE_KEY : `${SESSION_STORAGE_PREFIX}${sessionKey}`;
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.loadStoredState();
    return this.loadPromise;
  }

  private async loadStoredState(): Promise<void> {
    const stored = (await browser.storage.session.get([this.storageKey]))[this.storageKey];
    if (!isSessionState(stored)) return;
    try {
      await browser.windows.get(stored.agentWindowId);
      this.state = { ...stored, sessionKey: this.sessionKey };
      await this.refreshAgentTabs();
    } catch {
      await browser.storage.session.remove(this.storageKey);
    }
  }

  private async discardClosedAgentWindow(): Promise<void> {
    const checkedState = this.state;
    if (!checkedState) return;
    try {
      await browser.windows.get(checkedState.agentWindowId);
    } catch {
      if (this.state?.sessionId !== checkedState.sessionId) return;
      this.state = null;
      await this.persist();
    }
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    if (this.state) await browser.storage.session.set({ [this.storageKey]: this.state });
    else await browser.storage.session.remove(this.storageKey);
  }
  private async releaseTabBestEffort(tabId: number): Promise<void> {
    if (!this.releaseHook) return;
    try {
      await this.releaseHook(tabId);
    } catch {
      // Cleanup must continue even when page restoration fails.
    }
  }

  private refreshAgentTabs(): Promise<Browser.tabs.Tab[]> {
    this.refreshPromise ??= this.refreshAgentTabsNow().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshAgentTabsNow(): Promise<Browser.tabs.Tab[]> {
    const state = this.state;
    if (!state) return [];
    const tabs = await browser.tabs.query({ windowId: state.agentWindowId });
    if (this.state?.sessionId !== state.sessionId) return [];
    const ids = tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
    const activeOwnedTabId = tabs.find((tab) => tab.active && tab.id !== undefined)?.id;
    let selectedTabId = state.selectedTabId;
    if (
      selectedTabId === undefined ||
      (!ids.includes(selectedTabId) && !state.borrowedTabIds.includes(selectedTabId))
    ) {
      selectedTabId = activeOwnedTabId ?? ids[0] ?? state.borrowedTabIds[0];
    } else if (ids.includes(selectedTabId) && activeOwnedTabId !== undefined) {
      selectedTabId = activeOwnedTabId;
    }
    const ownedTabsChanged = ids.length !== state.ownedTabIds.length ||
      ids.some((id, index) => id !== state.ownedTabIds[index]);
    const selectionChanged = selectedTabId !== state.selectedTabId;
    if (ownedTabsChanged) state.ownedTabIds = ids;
    if (selectionChanged) state.selectedTabId = selectedTabId;
    if (ownedTabsChanged || selectionChanged) await this.persist();
    return tabs;
  }

  async start(name?: string, mobile?: MobileWindowRequest): Promise<SessionSummary & { started: boolean; viewport?: ViewportReadback | null }> {
    return this.serializeLifecycle(async () => {
      await this.load();
      await this.discardClosedAgentWindow();
      const requestedName = normalizeSessionName(name);
      const requestedMobile = mobile === undefined ? undefined : normalizeMobileWindow(mobile.width, mobile.height);
      if (this.state) {
        if (requestedName !== undefined && this.state.name !== requestedName) {
          throw new SessionError(
            'session_conflict',
            `The active browser session is named ${this.state.name ?? 'unnamed'}.`,
            'Stop the active session before starting one with a different name.',
          );
        }
        if (requestedMobile && (this.state.mobile?.width !== requestedMobile.width || this.state.mobile.height !== requestedMobile.height)) {
          throw new SessionError(
            'session_conflict',
            `The active browser session has ${this.state.mobile ? `a ${this.state.mobile.width}x${this.state.mobile.height} mobile` : 'a normal'} Agent Window.`,
            'Stop the active session before starting one with a different window mode.',
          );
        }
        await this.refreshAgentTabs();
        const existing = { ...this.state, connected: true, started: false };
        return this.state.mobile ? { ...existing, viewport: await this.measureViewport().catch(() => null) } : existing;
      }
      // Never raise or focus the Agent Window: it runs in the operator's own
      // browser and must not take over their screen or keyboard. The titled
      // placeholder page lets window managers route it at creation.
      // A mobile window is a popup: Chrome keeps normal windows at least
      // ~500px wide, but lets popups (no tab strip) go narrower.
      const agentWindow = await browser.windows.create({
        focused: false,
        type: requestedMobile ? 'popup' : 'normal',
        url: browser.runtime.getURL('/agent-window.html'),
        left: 0,
        top: 0,
        ...(requestedMobile ? { width: requestedMobile.width, height: requestedMobile.height } : {}),
      });
      if (!agentWindow || agentWindow.id === undefined) throw new Error('Chrome did not return an Agent Window id.');
      let viewport: ViewportReadback | undefined;
      if (requestedMobile) {
        try {
          viewport = await fitMobileWindow(agentWindow, requestedMobile);
        } catch (error) {
          try {
            await browser.windows.remove(agentWindow.id);
          } catch {
            // The window is already gone; nothing is left to clean up.
          }
          throw error;
        }
      }
      const tabIds = (agentWindow.tabs ?? []).map((tab) => tab.id).filter((id): id is number => id !== undefined);
      this.state = {
        sessionId: crypto.randomUUID(),
        sessionKey: this.sessionKey,
        ...(requestedName === undefined ? {} : { name: requestedName }),
        agentWindowId: agentWindow.id,
        ...(requestedMobile ? { mobile: requestedMobile } : {}),
        ownedTabIds: tabIds,
        borrowedTabIds: [],
        selectedTabId: tabIds[0],
        startedAtMs: Date.now(),
      };
      await this.persist();
      return { ...this.state, connected: true, started: true, ...(viewport ? { viewport } : {}) };
    });
  }

  async stop(): Promise<{ stopped: boolean; returnedTabIds: number[] }> {
    return this.serializeLifecycle(async () => {
      await this.load();
      if (!this.state) return { stopped: false, returnedTabIds: [] };
      const previous = this.state;
      for (const tabId of new Set([...previous.ownedTabIds, ...previous.borrowedTabIds])) await this.releaseTabBestEffort(tabId);
      this.state = null;
      await this.persist();
      try {
        await browser.windows.remove(previous.agentWindowId);
      } catch {
        // The operator may have already closed the dedicated window.
      }
      return { stopped: true, returnedTabIds: previous.borrowedTabIds };
    });
  }

  async setPaused(paused: boolean): Promise<void> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      const previous = state.paused;
      state.paused = paused;
      try {
        await this.persist();
      } catch (error) {
        state.paused = paused || previous;
        throw error;
      }
    });
  }

  async list(): Promise<SessionSummary[]> {
    await this.load();
    await this.discardClosedAgentWindow();
    if (!this.state) return [];
    await this.refreshAgentTabs();
    return [{ ...this.state, connected: true }];
  }

  async resize(params: { width?: number; height?: number; left?: number; top?: number }): Promise<chrome.windows.Window & { viewport: ViewportReadback | null }> {
    const state = await this.requireState();
    const updates: chrome.windows.UpdateInfo = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`${key} must be an integer between 0 and 10000.`);
        updates[key as keyof chrome.windows.UpdateInfo] = value as never;
      }
    }
    let resized: chrome.windows.Window;
    try {
      resized = await browser.windows.update(state.agentWindowId, updates);
    } catch {
      if (updates.left !== undefined || updates.top !== undefined) {
        throw new SessionError('window_resize_failed', 'The Agent Window could not be resized.', 'Move the dedicated window onto a visible display and retry.');
      }
      try {
        resized = await browser.windows.update(state.agentWindowId, { ...updates, left: 0, top: 0 });
      } catch {
        throw new SessionError('window_resize_failed', 'The Agent Window could not be resized or recovered on the primary display.', 'Disable window-manager rules for the Agent Window, move it onto a visible display, and retry.');
      }
    }
    // Chrome clamps instead of failing (a normal window never goes below ~500px
    // wide), so a successful update is not proof of the requested size.
    assertSizeApplied(resized, updates, state.mobile !== undefined);
    return { ...resized, viewport: await this.measureViewport().catch(() => null) };
  }

  /** The page's own innerWidth/innerHeight in the Agent Window's active tab. */
  private async measureViewport(): Promise<ViewportReadback> {
    const state = this.state;
    if (!state) throw new SessionError('session_required', 'Start a browser session before using this command.');
    const [activeTab] = await browser.tabs.query({ windowId: state.agentWindowId, active: true });
    if (activeTab?.id === undefined) throw new SessionError('viewport_unreadable', 'The Agent Window has no active tab to measure.');
    return readViewport(activeTab.id, state.agentWindowId);
  }

  async listTabs(): Promise<Browser.tabs.Tab[]> {
    const state = await this.requireState();
    const tabs = await this.refreshAgentTabs();
    const borrowed = await Promise.all(state.borrowedTabIds.map(async (tabId) => {
      try {
        return await browser.tabs.get(tabId);
      } catch {
        return null;
      }
    }));
    return [...tabs, ...borrowed.filter((tab): tab is Browser.tabs.Tab => tab !== null)];
  }

  async createTab(url?: string): Promise<Browser.tabs.Tab> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      if (url !== undefined && !isNavigableUrl(url)) {
        throw new SessionError('invalid_url', 'Only http and https navigation is allowed.');
      }
      // Chrome opens tabs requested for a popup window in a normal window instead,
      // which would put an Agent tab in the operator's own browser.
      if (state.mobile) {
        throw new SessionError('mobile_window_single_tab', 'A mobile Agent Window holds exactly one tab.', 'Navigate the existing tab instead of creating another.');
      }
      const tab = await browser.tabs.create({ windowId: state.agentWindowId, url: url ?? 'about:blank', active: true });
      if (tab.id === undefined) throw new Error('Chrome did not return a tab id.');
      if (!state.ownedTabIds.includes(tab.id)) state.ownedTabIds.push(tab.id);
      state.selectedTabId = tab.id;
      await this.persist();
      return tab;
    });
  }

  async selectTab(tabId: number): Promise<Browser.tabs.Tab> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      if (!(await this.ownsTab(tabId))) throw new SessionError('tab_not_owned', 'Tab is not owned or borrowed by this session.');
      const tab = await browser.tabs.get(tabId);
      await browser.tabs.update(tabId, { active: true });
      state.selectedTabId = tabId;
      await this.persist();
      return { ...tab, active: true };
    });
  }

  async closeTab(tabId: number): Promise<{ closed: boolean }> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      await this.refreshAgentTabs();
      if (!(await this.ownsTab(tabId))) throw new SessionError('tab_not_owned', 'Tab is not owned or borrowed by this session.');
      if (state.borrowedTabIds.includes(tabId)) {
        throw new SessionError(
          'borrowed_tab_close_forbidden',
          'Borrowed user tabs cannot be closed by the agent.',
          'Return the borrowed tab, or close it yourself in the browser.',
        );
      }
      if (state.ownedTabIds.length <= 1) {
        throw new SessionError(
          'last_owned_tab_close_forbidden',
          'The last Agent Window tab cannot be closed because it would invalidate the active session.',
          'Navigate the existing tab or create another owned tab before closing it.',
        );
      }
      await browser.tabs.remove(tabId);
      state.ownedTabIds = state.ownedTabIds.filter((id) => id !== tabId);
      state.borrowedTabIds = state.borrowedTabIds.filter((id) => id !== tabId);
      if (state.selectedTabId === tabId) state.selectedTabId = state.ownedTabIds[0] ?? state.borrowedTabIds[0];
      await this.persist();
      return { closed: true };
    });
  }

  async borrowTab(tabId: number): Promise<Browser.tabs.Tab> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      await this.assertTabAvailable?.(tabId);
      const tab = await browser.tabs.get(tabId);
      if (tab.windowId === state.agentWindowId || state.ownedTabIds.includes(tabId) || state.borrowedTabIds.includes(tabId)) {
        if (tab.windowId === state.agentWindowId && !state.ownedTabIds.includes(tabId)) state.ownedTabIds.push(tabId);
        state.selectedTabId = tabId;
        await this.persist();
        return tab;
      }
      if (!tab.url || !isNavigableUrl(tab.url)) {
        throw new SessionError('unsupported_page', 'Only http and https tabs can be borrowed.');
      }
      state.borrowedTabIds.push(tabId);
      state.selectedTabId = tabId;
      await this.persist();
      return tab;
    });
  }
  async returnTab(tabId: number): Promise<{ returned: boolean }> {
    return this.serializeLifecycle(async () => {
      const state = await this.requireState();
      const wasBorrowed = state.borrowedTabIds.includes(tabId);
      if (wasBorrowed) await this.releaseTabBestEffort(tabId);
      state.borrowedTabIds = state.borrowedTabIds.filter((id) => id !== tabId);
      if (state.selectedTabId === tabId) state.selectedTabId = state.ownedTabIds[0] ?? state.borrowedTabIds[0];
      await this.persist();
      return { returned: wasBorrowed };
    });
  }

  async cleanupTab(tabId: number): Promise<void> {
    return this.serializeLifecycle(async () => {
      await this.load();
      const state = this.state;
      if (!state || (!state.ownedTabIds.includes(tabId) && !state.borrowedTabIds.includes(tabId))) return;
      await this.releaseTabBestEffort(tabId);
    });
  }

  async requireState(): Promise<SessionState> {
    await this.load();
    await this.discardClosedAgentWindow();
    if (!this.state) throw new SessionError('session_required', 'Start a browser session before using this command.');
    return this.state;
  }

  async ownsTab(tabId: number): Promise<boolean> {
    const state = await this.requireState();
    await this.assertTabAvailable?.(tabId);
    let tab: Browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      state.ownedTabIds = state.ownedTabIds.filter((id) => id !== tabId);
      state.borrowedTabIds = state.borrowedTabIds.filter((id) => id !== tabId);
      if (state.selectedTabId === tabId) state.selectedTabId = undefined;
      await this.persist();
      return false;
    }
    if (state.borrowedTabIds.includes(tabId)) return true;
    if (tab.windowId === state.agentWindowId) {
      if (!state.ownedTabIds.includes(tabId)) {
        state.ownedTabIds.push(tabId);
        await this.persist();
      }
      return true;
    }
    if (state.ownedTabIds.includes(tabId)) {
      state.ownedTabIds = state.ownedTabIds.filter((id) => id !== tabId);
      if (state.selectedTabId === tabId) state.selectedTabId = undefined;
      await this.persist();
    }
    return false;
  }

  async getSelectedTabId(): Promise<number> {
    const state = await this.requireState();
    if (state.selectedTabId !== undefined && state.borrowedTabIds.includes(state.selectedTabId) && await this.ownsTab(state.selectedTabId)) {
      return state.selectedTabId;
    }
    const [activeOwnedTab] = await browser.tabs.query({ windowId: state.agentWindowId, active: true });
    if (activeOwnedTab?.id !== undefined && await this.ownsTab(activeOwnedTab.id)) {
      if (state.selectedTabId !== activeOwnedTab.id) {
        state.selectedTabId = activeOwnedTab.id;
        await this.persist();
      }
      return activeOwnedTab.id;
    }
    if (state.selectedTabId !== undefined && await this.ownsTab(state.selectedTabId)) return state.selectedTabId;
    const tabs = await this.listTabs();
    const fallback = tabs.find((tab) => tab.id !== undefined)?.id;
    if (fallback === undefined) throw new SessionError('tab_required', 'The session has no controllable tab.');
    state.selectedTabId = fallback;
    await this.persist();
    return fallback;
  }
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Validates a mobile viewport request; omitted sides take the 375x812 phone default. */
export function normalizeMobileWindow(width: number | undefined, height: number | undefined): MobileWindowRequest {
  const request = { width: width ?? MOBILE_VIEWPORT_DEFAULT.width, height: height ?? MOBILE_VIEWPORT_DEFAULT.height };
  if (!isMobileRequest(request)) {
    throw new SessionError(
      'invalid_mobile_window',
      `A mobile window needs an integer width of ${MOBILE_WIDTH_RANGE[0]}–${MOBILE_WIDTH_RANGE[1]} and height of ${MOBILE_HEIGHT_RANGE[0]}–${MOBILE_HEIGHT_RANGE[1]} CSS pixels.`,
    );
  }
  return request;
}

function isMobileRequest(value: unknown): value is MobileWindowRequest {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as Partial<MobileWindowRequest>;
  return Number.isInteger(width) && width! >= MOBILE_WIDTH_RANGE[0] && width! <= MOBILE_WIDTH_RANGE[1] &&
    Number.isInteger(height) && height! >= MOBILE_HEIGHT_RANGE[0] && height! <= MOBILE_HEIGHT_RANGE[1];
}

/**
 * Reads window.innerWidth/innerHeight from the page. The page may still be
 * committing right after the window opens, so a failed injection is retried.
 */
async function readViewport(tabId: number, windowId?: number): Promise<ViewportReadback> {
  let lastError: unknown;
  for (let attempt = 0; attempt < VIEWPORT_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, VIEWPORT_READ_DELAY_MS));
    try {
      let result: Partial<ViewportReadback> | undefined;
      try {
        const [injection] = await browser.scripting.executeScript({
          target: { tabId },
          func: () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }),
        });
        result = injection?.result as Partial<ViewportReadback> | undefined;
      } catch (error) {
        // chrome.scripting cannot reach extension pages, including the Agent
        // Window placeholder; that page answers a viewport message instead.
        if (windowId === undefined) throw error;
        result = (await browser.runtime.sendMessage({ type: AGENT_WINDOW_VIEWPORT_MESSAGE, windowId })) as Partial<ViewportReadback> | undefined;
      }
      if (Number.isInteger(result?.width) && Number.isInteger(result?.height) && typeof result?.devicePixelRatio === 'number') {
        return { width: result.width!, height: result.height!, devicePixelRatio: result.devicePixelRatio };
      }
      lastError = new Error('The page returned no viewport.');
    } catch (error) {
      lastError = error;
    }
  }
  throw new SessionError(
    'viewport_unreadable',
    `The Agent Window viewport could not be measured: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    'Check that the Agent Window is open on an http(s) page or the placeholder page, then retry.',
  );
}

/**
 * Resizes a freshly opened popup until the page itself reports the requested
 * viewport. Window sizes include the frame, so one corrective update closes the
 * gap (title bar on macOS, borders on Windows/Linux). A viewport that stays
 * wider than requested means Chrome clamped the window: fail, never report it as
 * the requested width. A shorter screen only limits the height, which is reported.
 */
async function fitMobileWindow(agentWindow: chrome.windows.Window, wanted: MobileWindowRequest): Promise<ViewportReadback> {
  const tabId = agentWindow.tabs?.find((tab) => tab.id !== undefined)?.id;
  if (agentWindow.id === undefined || tabId === undefined) throw new SessionError('viewport_unreadable', 'Chrome did not return the mobile window tab.');
  let viewport = await readViewport(tabId, agentWindow.id);
  for (let correction = 0; correction < 2 && (viewport.width !== wanted.width || viewport.height !== wanted.height); correction += 1) {
    const current = await browser.windows.get(agentWindow.id);
    if (current.width === undefined || current.height === undefined) break;
    await browser.windows.update(agentWindow.id, {
      width: Math.max(1, current.width + wanted.width - viewport.width),
      height: Math.max(1, current.height + wanted.height - viewport.height),
    });
    viewport = await readViewport(tabId, agentWindow.id);
  }
  if (viewport.width !== wanted.width) {
    throw new SessionError(
      'window_size_clamped',
      `Chrome gave the mobile window a ${viewport.width}px-wide viewport, not the requested ${wanted.width}px.`,
      `Chrome will not make a window this narrow on this system. Request ${viewport.width}px or wider, or treat layouts below ${viewport.width}px as untested here.`,
    );
  }
  return viewport;
}

/** Throws when Chrome applied a different window size than requested. */
function assertSizeApplied(applied: chrome.windows.Window, requested: chrome.windows.UpdateInfo, mobile: boolean): void {
  const wrongWidth = requested.width !== undefined && applied.width !== undefined && Math.abs(applied.width - requested.width) > SIZE_TOLERANCE_PX;
  const wrongHeight = requested.height !== undefined && applied.height !== undefined && Math.abs(applied.height - requested.height) > SIZE_TOLERANCE_PX;
  if (!wrongWidth && !wrongHeight) return;
  const asked = `${requested.width ?? 'unchanged'}x${requested.height ?? 'unchanged'}`;
  const got = `${applied.width ?? 'unknown'}x${applied.height ?? 'unknown'}`;
  const tooNarrow = wrongWidth && applied.width! > requested.width!;
  throw new SessionError(
    'window_size_clamped',
    `Chrome resized the Agent Window to ${got}, not the requested ${asked}; the window now stays at ${got}.`,
    tooNarrow && !mobile
      ? 'Chrome keeps normal windows about 500px wide at minimum. Stop the session and start one with --mobile for phone widths.'
      : 'Request a size that fits the display and Chrome\'s minimum window size.',
  );
}

function normalizeSessionName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SessionError('invalid_session_name', 'Session names must contain 1–64 printable characters.');
  }
  return normalized;
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionState>;
  return typeof candidate.sessionId === 'string' &&
    (candidate.name === undefined || (typeof candidate.name === 'string' && candidate.name.length >= 1 && candidate.name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(candidate.name))) &&
    Number.isInteger(candidate.agentWindowId) &&
    Array.isArray(candidate.ownedTabIds) && candidate.ownedTabIds.every((id) => Number.isInteger(id)) &&
    Array.isArray(candidate.borrowedTabIds) && candidate.borrowedTabIds.every((id) => Number.isInteger(id)) &&
    (candidate.selectedTabId === undefined || Number.isInteger(candidate.selectedTabId)) &&
    (candidate.mobile === undefined || isMobileRequest(candidate.mobile)) &&
    (candidate.paused === undefined || typeof candidate.paused === 'boolean') && Number.isFinite(candidate.startedAtMs);
}
