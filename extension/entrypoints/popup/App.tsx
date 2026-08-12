import { useEffect, useState } from 'react';
import { requestOriginAccess, revokeOriginAccess } from '../../src/permissions';

type PermissionState = {
  meetingHosts: true;
  optionalSiteAccess: boolean;
  currentOrigin?: string;
  currentOriginAccess: boolean;
};

type ActiveTab = {
  id: number;
  window_id?: number;
  url?: string;
  title?: string;
  owned: boolean;
  borrowed: boolean;
};

type PopupState = {
  connected: boolean;
  evaluate_enabled: boolean;
  takeover_requested: boolean;
  native_error: { code: string; message: string } | null;
  permissions: PermissionState;
  sessions: Array<{ sessionId: string; agentWindowId: number; startedAtMs: number }>;
  active_tab: ActiveTab | null;
};

type RuntimeReply = Partial<PopupState> & { granted?: boolean; enabled?: boolean; ok?: boolean; error?: { message?: string } };

const initialState: PopupState = {
  connected: false,
  evaluate_enabled: false,
  takeover_requested: false,
  native_error: null,
  permissions: { meetingHosts: true, optionalSiteAccess: false, currentOriginAccess: false },
  sessions: [],
  active_tab: null,
};

export default function App() {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = async (): Promise<void> => {
    const reply = (await browser.runtime.sendMessage({ kind: 'popup_state' })) as RuntimeReply;
    setState((current) => ({
      ...current,
      ...reply,
      permissions: reply.permissions ?? current.permissions,
      active_tab: reply.active_tab !== undefined ? reply.active_tab : current.active_tab,
    }));
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const setConnection = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      await browser.runtime.sendMessage({ kind: 'set_connection', enabled });
      await refresh();
    } catch {
      setNotice('The local native host is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const requestCurrentOrigin = async (): Promise<void> => {
    const origin = state.permissions.currentOrigin;
    if (!origin) {
      setNotice('The active tab is not an http or https site.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      if (state.permissions.currentOriginAccess) {
        const revoked = await revokeOriginAccess(origin);
        setNotice(revoked ? `Access disabled for ${origin}` : 'No explicit site access was found for this origin.');
      } else {
        const granted = await requestOriginAccess(origin);
        setNotice(granted ? `Access enabled for ${origin}` : 'No additional site access was granted.');
      }
      await refresh();
    } catch {
      setNotice('Site access can only be changed from this user action.');
    } finally {
      setBusy(false);
    }
  };

  const requestAllOrigins = async (): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const granted = await browser.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      setNotice(granted ? 'All http/https site access enabled.' : 'No additional site access was granted.');
      await refresh();
    } catch {
      setNotice('Site access can only be requested from this user action.');
    } finally {
      setBusy(false);
    }
  };

  const setEvaluate = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await browser.runtime.sendMessage({ kind: 'set_capability', capability: 'evaluate', enabled });
      setState((current) => ({ ...current, evaluate_enabled: enabled }));
    } finally {
      setBusy(false);
    }
  };

  const setTakeover = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await browser.runtime.sendMessage({ kind: 'set_takeover', enabled });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setActiveBorrowed = async (borrowed: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: borrowed ? 'popup_borrow_active' : 'popup_return_active' })) as RuntimeReply;
      if (reply.ok === false) setNotice(reply.error?.message ?? 'The active tab could not be updated.');
      await refresh();
    } catch {
      setNotice('The active tab could not be updated from this user action.');
    } finally {
      setBusy(false);
    }
  };

  const currentOriginLabel = state.permissions.currentOrigin?.replace(/\/\*$/, '') ?? 'the active site';
  const activeTab = state.active_tab;
  const activeTabLabel = activeTab?.title || activeTab?.url || 'No active browser tab';

  return (
    <main className="popup" aria-labelledby="title">
      <header className="brand">
        <img src={browser.runtime.getURL('/icon.svg')} alt="" width="32" height="32" />
        <div>
          <p className="eyebrow">LOCAL CONTROL</p>
          <h1 id="title">OverSeer Browser</h1>
        </div>
      </header>

      <section className="connection-panel" aria-labelledby="connection-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONNECTION</p>
            <h2 id="connection-heading">{state.connected ? 'Connected locally' : 'Not connected'}</h2>
          </div>
          <span className={`status-dot ${state.connected ? 'online' : 'offline'}`} aria-label={state.connected ? 'Connected' : 'Disconnected'} />
        </div>
        <p className="body-copy">Extension and native-host transport stay local. Page content and screenshots are returned only for explicit commands and may be sent to the configured AI provider. Meeting reminders send only a minimized opaque payload locally.</p>
        <button className={state.connected ? 'button secondary' : 'button primary'} type="button" onClick={() => void setConnection(!state.connected)} disabled={busy}>
          {state.connected ? 'Disconnect' : 'Connect local host'}
        </button>
      </section>

      <section className="section" aria-labelledby="active-tab-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">ACTIVE TAB</p>
            <h2 id="active-tab-heading">{activeTabLabel}</h2>
          </div>
          <span className={`tag ${activeTab?.borrowed || activeTab?.owned ? 'tag-on' : ''}`}>{activeTab?.borrowed ? 'BORROWED' : activeTab?.owned ? 'SESSION-OWNED' : 'UNCONTROLLED'}</span>
        </div>
        <p className="muted">{activeTab?.url ?? 'Select a browser tab to borrow it for automation.'}</p>
        <button className="button secondary" type="button" onClick={() => void setActiveBorrowed(!activeTab?.borrowed)} disabled={busy || !activeTab || activeTab.owned}>
          {activeTab?.borrowed ? 'Return active tab' : 'Borrow active tab'}
        </button>
      </section>

      <section className="section" aria-labelledby="meeting-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">MEETING REMINDERS</p>
            <h2 id="meeting-heading">Meet and Zoom detection</h2>
          </div>
          <span className="tag">ON</span>
        </div>
        <p className="body-copy">Only exact Meet and Zoom hosts are watched. A salted opaque key is sent locally; URLs, titles, participants, and page text are never included.</p>
        <p className="muted">Recording still requires an explicit confirmation in UltraVox.</p>
      </section>

      <section className="section" aria-labelledby="access-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">CAPABILITIES</p>
            <h2 id="access-heading">Site access</h2>
          </div>
          <span className={`tag ${state.permissions.currentOriginAccess ? 'tag-on' : ''}`}>{state.permissions.currentOriginAccess ? 'GRANTED' : 'OFF'}</span>
        </div>
        <p className="body-copy">General control is off by default. Grant access only to {currentOriginLabel}; meeting reminders do not need site access.</p>
        <button className="button secondary" type="button" onClick={() => void requestCurrentOrigin()} disabled={busy || !state.permissions.currentOrigin}>
          {state.permissions.currentOriginAccess ? `Revoke access for ${currentOriginLabel}` : `Grant access for ${currentOriginLabel}`}
        </button>
        <details className="advanced-access">
          <summary>Advanced: grant all http/https sites</summary>
          <p className="muted">This is broader than most operators need and lets the local host control any standard web origin.</p>
          <button className="button secondary" type="button" onClick={() => void requestAllOrigins()} disabled={busy || state.permissions.optionalSiteAccess}>Grant all sites</button>
        </details>
        <label className="capability-row">
          <input type="checkbox" checked={state.evaluate_enabled} onChange={(event) => void setEvaluate(event.target.checked)} disabled={busy} />
          <span>
            <strong>Enable page evaluation</strong>
            <small>High-risk capability. Only session-owned or explicitly borrowed tabs; requests remain local.</small>
          </span>
        </label>
      </section>

      {state.takeover_requested ? (
        <section className="takeover" aria-labelledby="takeover-heading">
          <strong id="takeover-heading">Human takeover active</strong>
          <p>Browser actions are paused until you return control.</p>
          <button className="button secondary" type="button" onClick={() => void setTakeover(false)} disabled={busy}>Return control to agent</button>
        </section>
      ) : null}
      {state.native_error ? (
        <p className="notice" role="alert">
          Local host error ({state.native_error.code}): {state.native_error.message}
        </p>
      ) : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <footer>v0.1 · local-only by design</footer>
    </main>
  );
}
