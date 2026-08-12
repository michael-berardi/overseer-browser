import { canControlUrl, isNavigableUrl } from './permissions';

const SESSION_STORAGE_KEY = 'overseer.session.v1';

export interface SessionState {
  sessionId: string;
  agentWindowId: number;
  ownedTabIds: number[];
  borrowedTabIds: number[];
  selectedTabId?: number;
  startedAtMs: number;
}

export interface SessionSummary extends SessionState {
  connected: boolean;
}

export class SessionManager {
  private state: SessionState | null = null;
  private loadPromise: Promise<void> | null = null;
  private lifecycle: Promise<void> = Promise.resolve();

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

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    if (this.state) await browser.storage.session.set({ [SESSION_STORAGE_KEY]: this.state });
    else await browser.storage.session.remove(SESSION_STORAGE_KEY);
  }

  private async refreshAgentTabs(): Promise<Browser.tabs.Tab[]> {
    const state = this.state;
    if (!state) return [];
    const tabs = await browser.tabs.query({ windowId: state.agentWindowId });
    const ids = tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
    state.ownedTabIds = ids;
    if (
      state.selectedTabId === undefined ||
      (!state.ownedTabIds.includes(state.selectedTabId) && !state.borrowedTabIds.includes(state.selectedTabId))
    ) state.selectedTabId = ids[0] ?? state.borrowedTabIds[0];
    await this.persist();
    return tabs;
  }

  async start(): Promise<SessionSummary> {
    return this.serializeLifecycle(async () => {
      await this.load();
      if (this.state) {
        await this.refreshAgentTabs();
        return { ...this.state, connected: true };
      }
      const agentWindow = await browser.windows.create({ focused: true, type: 'normal', url: 'about:blank' });
      if (!agentWindow || agentWindow.id === undefined) throw new Error('Chrome did not return an Agent Window id.');
      const tabIds = (agentWindow.tabs ?? []).map((tab) => tab.id).filter((id): id is number => id !== undefined);
      this.state = {
        sessionId: crypto.randomUUID(),
        agentWindowId: agentWindow.id,
        ownedTabIds: tabIds,
        borrowedTabIds: [],
        selectedTabId: tabIds[0],
        startedAtMs: Date.now(),
      };
      await this.persist();
      return { ...this.state, connected: true };
    });
  }

  async stop(): Promise<{ stopped: boolean; returnedTabIds: number[] }> {
    return this.serializeLifecycle(async () => {
      await this.load();
      if (!this.state) return { stopped: false, returnedTabIds: [] };
      const previous = this.state;
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
    return browser.windows.update(state.agentWindowId, updates);
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
    const state = await this.requireState();
    if (url !== undefined && (!isNavigableUrl(url) || !(await canControlUrl(url)))) {
      throw new SessionError('permission_required', 'Optional site access is required for this URL.', 'Grant site access from the popup.');
    }
    const tab = await browser.tabs.create({ windowId: state.agentWindowId, url: url ?? 'about:blank', active: true });
    if (tab.id === undefined) throw new Error('Chrome did not return a tab id.');
    if (!state.ownedTabIds.includes(tab.id)) state.ownedTabIds.push(tab.id);
    state.selectedTabId = tab.id;
    await this.persist();
    return tab;
  }

  async selectTab(tabId: number): Promise<Browser.tabs.Tab> {
    const state = await this.requireState();
    if (!(await this.ownsTab(tabId))) throw new SessionError('tab_not_owned', 'Tab is not owned or borrowed by this session.');
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tabId, { active: true });
    state.selectedTabId = tabId;
    await this.persist();
    return tab;
  }

  async closeTab(tabId: number): Promise<{ closed: boolean }> {
    const state = await this.requireState();
    if (!(await this.ownsTab(tabId))) throw new SessionError('tab_not_owned', 'Tab is not owned or borrowed by this session.');
    await browser.tabs.remove(tabId);
    state.ownedTabIds = state.ownedTabIds.filter((id) => id !== tabId);
    state.borrowedTabIds = state.borrowedTabIds.filter((id) => id !== tabId);
    if (state.selectedTabId === tabId) state.selectedTabId = state.ownedTabIds[0] ?? state.borrowedTabIds[0];
    await this.persist();
    return { closed: true };
  }

  async borrowTab(tabId: number): Promise<Browser.tabs.Tab> {
    const state = await this.requireState();
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === state.agentWindowId || state.ownedTabIds.includes(tabId) || state.borrowedTabIds.includes(tabId)) {
      if (tab.windowId === state.agentWindowId && !state.ownedTabIds.includes(tabId)) state.ownedTabIds.push(tabId);
      state.selectedTabId = tabId;
      await this.persist();
      return tab;
    }
    if (!tab.url || !(await canControlUrl(tab.url))) {
      throw new SessionError('permission_required', 'Optional site access is required before borrowing this tab.', 'Grant site access from the popup.');
    }
    state.borrowedTabIds.push(tabId);
    state.selectedTabId = tabId;
    await this.persist();
    return tab;
  }

  async returnTab(tabId: number): Promise<{ returned: boolean }> {
    const state = await this.requireState();
    const wasBorrowed = state.borrowedTabIds.includes(tabId);
    state.borrowedTabIds = state.borrowedTabIds.filter((id) => id !== tabId);
    if (state.selectedTabId === tabId) state.selectedTabId = state.ownedTabIds[0] ?? state.borrowedTabIds[0];
    await this.persist();
    return { returned: wasBorrowed };
  }

  async requireState(): Promise<SessionState> {
    await this.load();
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

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionState>;
  return typeof candidate.sessionId === 'string' && Number.isInteger(candidate.agentWindowId) &&
    Array.isArray(candidate.ownedTabIds) && candidate.ownedTabIds.every((id) => Number.isInteger(id)) &&
    Array.isArray(candidate.borrowedTabIds) && candidate.borrowedTabIds.every((id) => Number.isInteger(id)) &&
    (candidate.selectedTabId === undefined || Number.isInteger(candidate.selectedTabId)) && Number.isFinite(candidate.startedAtMs);
}
