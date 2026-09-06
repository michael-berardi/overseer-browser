import { SessionError, SessionManager, SESSION_STORAGE_KEY, SESSION_STORAGE_PREFIX, type SessionReleaseHook, type SessionSummary } from './session';

export const MAX_BROWSER_SESSIONS = 32;
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function normalizeSessionKey(value: unknown): string {
  if (value === undefined) return 'default';
  if (typeof value !== 'string' || !SESSION_KEY_PATTERN.test(value)) {
    throw new SessionError('invalid_session_key', 'Session keys must contain 1–128 ASCII letters, digits, dots, colons, underscores or hyphens.');
  }
  return value;
}

/** Routing is request-local. There is deliberately no globally selected session. */
export class SessionRegistry {
  private readonly managers = new Map<string, SessionManager>();
  private loaded: Promise<void> | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private claims: Promise<void> = Promise.resolve();

  constructor(private readonly releaseHook?: SessionReleaseHook) {}

  private manager(key: string): SessionManager {
    return new SessionManager(this.releaseHook, key, (tabId) => this.assertTabAvailable(key, tabId));
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const stored = await browser.storage.session.get(null);
      for (const storageKey of Object.keys(stored)) {
        const key = storageKey === SESSION_STORAGE_KEY ? 'default'
          : storageKey.startsWith(SESSION_STORAGE_PREFIX) ? storageKey.slice(SESSION_STORAGE_PREFIX.length) : undefined;
        if (key === undefined || !SESSION_KEY_PATTERN.test(key)) continue;
        if (this.managers.size >= MAX_BROWSER_SESSIONS) {
          throw new SessionError('session_capacity_exceeded', 'Too many stored browser sessions. Stop an existing session before starting another.');
        }
        this.managers.set(key, this.manager(key));
      }
    })();
    return this.loaded;
  }

  async get(value?: string): Promise<SessionManager> {
    const key = normalizeSessionKey(value);
    await this.load();
    // Read-only probes for missing scopes do not allocate permanent contexts.
    return this.managers.get(key) ?? this.manager(key);
  }

  async list(): Promise<SessionSummary[]> {
    await this.load();
    return (await Promise.all([...this.managers.values()].map((manager) => manager.list()))).flat();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(work, work);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  start(value?: string, name?: string): Promise<SessionSummary & { started: boolean }> {
    return this.serialize(async () => {
      const key = normalizeSessionKey(value);
      await this.load();
      const active = await this.list();
      const existing = this.managers.get(key);
      if (!active.some((session) => session.sessionKey === key) && active.length >= MAX_BROWSER_SESSIONS) {
        throw new SessionError('session_capacity_exceeded', `At most ${MAX_BROWSER_SESSIONS} browser sessions may run simultaneously.`);
      }
      for (const cachedKey of this.managers.keys()) {
        if (cachedKey !== key && !active.some((session) => session.sessionKey === cachedKey)) this.managers.delete(cachedKey);
      }
      const manager = existing ?? this.manager(key);
      this.managers.set(key, manager);
      try {
        return await manager.start(name);
      } catch (error) {
        if (!(await manager.list()).length) this.managers.delete(key);
        throw error;
      }
    });
  }

  stop(value?: string): Promise<{ stopped: boolean; returnedTabIds: number[] }> {
    return this.serialize(async () => {
      const key = normalizeSessionKey(value);
      const manager = await this.get(key);
      const result = await manager.stop();
      this.managers.delete(key);
      return result;
    });
  }

  async assertTabAvailable(key: string, tabId: number): Promise<void> {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    await this.load();
    const peers = await Promise.all([...this.managers.entries()].filter(([peerKey]) => peerKey !== key).map(async ([, manager]) => {
      try { return await manager.requireState(); }
      catch (error) {
        if (error instanceof SessionError && error.code === 'session_required') return undefined;
        throw error;
      }
    }));
    const other = peers.find((session) => session && (
      session.ownedTabIds.includes(tabId) || session.borrowedTabIds.includes(tabId) ||
      (tab?.windowId !== undefined && session.agentWindowId === tab.windowId)
    ));
    if (other) throw new SessionError('tab_owned_by_another_session', 'This tab belongs to another browser session. Use your own Agent Window.');
  }

  borrow(value: string | undefined, tabId: number): Promise<Browser.tabs.Tab> {
    const work = async (): Promise<Browser.tabs.Tab> => (await this.get(value)).borrowTab(tabId);
    // The ownership check and claim must be atomic across ALL sessions.
    const result = this.claims.then(work, work);
    this.claims = result.then(() => undefined, () => undefined);
    return result;
  }

  async popupTarget(value?: string): Promise<SessionManager> {
    if (value !== undefined) {
      const manager = await this.get(value);
      await manager.requireState();
      return manager;
    }
    const active = await this.list();
    if (active.length !== 1) throw new SessionError('session_selection_required', 'Choose the intended session in the popup before borrowing or returning a tab.');
    return this.get(active[0]?.sessionKey);
  }

  async cleanupConsoles(): Promise<void> {
    for (const session of await this.list()) {
      const manager = await this.get(session.sessionKey);
      await Promise.all([...new Set([...session.ownedTabIds, ...session.borrowedTabIds])].map((tabId) => manager.cleanupTab(tabId)));
    }
  }
}
