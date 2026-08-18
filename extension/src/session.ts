import { isNavigableUrl } from './permissions';

const SESSION_STORAGE_KEY = 'overseer.session.v1';

export interface SessionState {
  sessionId: string;
  agentWindowId: number;
  ownedTabIds: number[];
  borrowedTabIds: number[];
  name?: string;
  selectedTabId?: number;
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

  constructor(private readonly releaseHook?: SessionReleaseHook) {}

  private load(): Promise<void> {
    this.loadPromise ??= this.loadStoredState();
    return this.loadPromise;
  }

  private async loadStoredState(): Promise<void> {
    const stored = (await browser.storage.session.get([SESSION_STORAGE_KEY]))[SESSION_STORAGE_KEY];
    if (!isSessionState(stored)) return;
    try {
      await browser.windows.get(stored.agentWindowId);
      this.state = stored;
      await this.refreshAgentTabs();
    } catch {
      await browser.storage.session.remove(SESSION_STORAGE_KEY);
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
    if (this.state) await browser.storage.session.set({ [SESSION_STORAGE_KEY]: this.state });
    else await browser.storage.session.remove(SESSION_STORAGE_KEY);
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

  async start(name?: string): Promise<SessionSummary & { started: boolean }> {
    return this.serializeLifecycle(async () => {
      await this.load();
      await this.discardClosedAgentWindow();
      const requestedName = normalizeSessionName(name);
      if (this.state) {
        if (requestedName !== undefined && this.state.name !== requestedName) {
          throw new SessionError(
            'session_conflict',
            `The active browser session is named ${this.state.name ?? 'unnamed'}.`,
            'Stop the active session before starting one with a different name.',
          );
        }
        await this.refreshAgentTabs();
        return { ...this.state, connected: true, started: false };
      }
      const agentWindow = await browser.windows.create({ focused: true, type: 'normal', url: 'about:blank', left: 0, top: 0 });
      if (!agentWindow || agentWindow.id === undefined) throw new Error('Chrome did not return an Agent Window id.');
      const tabIds = (agentWindow.tabs ?? []).map((tab) => tab.id).filter((id): id is number => id !== undefined);
      this.state = {
        sessionId: crypto.randomUUID(),
        ...(requestedName === undefined ? {} : { name: requestedName }),
        agentWindowId: agentWindow.id,
        ownedTabIds: tabIds,
        borrowedTabIds: [],
        selectedTabId: tabIds[0],
        startedAtMs: Date.now(),
      };
      await this.persist();
      return { ...this.state, connected: true, started: true };
    });
  }

  async stop(): Promise<{ stopped: boolean; returnedTabIds: number[] }> {
    return this.serializeLifecycle(async () => {
      await this.load();
      if (!this.state) return { stopped: false, returnedTabIds: [] };
      const previous = this.state;
      for (const tabId of previous.borrowedTabIds) await this.releaseTabBestEffort(tabId);
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

  async list(): Promise<SessionSummary[]> {
    await this.load();
    await this.discardClosedAgentWindow();
    if (!this.state) return [];
    await this.refreshAgentTabs();
    return [{ ...this.state, connected: true }];
  }

  async resize(params: { width?: number; height?: number; left?: number; top?: number }): Promise<chrome.windows.Window> {
    const state = await this.requireState();
    const updates: chrome.windows.UpdateInfo = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`${key} must be an integer between 0 and 10000.`);
        updates[key as keyof chrome.windows.UpdateInfo] = value as never;
      }
    }
    try {
      return await browser.windows.update(state.agentWindowId, updates);
    } catch {
      if (updates.left !== undefined || updates.top !== undefined) {
        throw new SessionError('window_resize_failed', 'The Agent Window could not be resized.', 'Move the dedicated window onto a visible display and retry.');
      }
      try {
        return await browser.windows.update(state.agentWindowId, { ...updates, left: 0, top: 0 });
      } catch {
        throw new SessionError('window_resize_failed', 'The Agent Window could not be resized or recovered on the primary display.', 'Disable window-manager rules for the Agent Window, move it onto a visible display, and retry.');
      }
    }
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
      if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
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
    (candidate.selectedTabId === undefined || Number.isInteger(candidate.selectedTabId)) && Number.isFinite(candidate.startedAtMs);
}
