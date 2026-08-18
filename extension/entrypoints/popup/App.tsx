import { useEffect, useState } from 'react';
import type { PermissionState } from '../../src/permissions';
import type { TelemetryConsent } from '../../src/telemetry';


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
  native_enabled: boolean;
  evaluate_enabled: boolean;
  takeover_requested: boolean;
  native_error: { code: string; message: string } | null;
  permissions: PermissionState;
  sessions: Array<{ sessionId: string; agentWindowId: number; startedAtMs: number }>;
  telemetry_consent: TelemetryConsent;
  active_tab: ActiveTab | null;
};

type RuntimeReply = Partial<PopupState> & {
  enabled?: boolean;
  ok?: boolean;
  error?: { message?: unknown } | string;
};

export const MEETING_HOST_POLICY = 'Only the exact Meet host meet.google.com and Zoom provider subdomains such as us02web.zoom.us are watched.';
export const SITE_ACCESS_POLICY = 'Agents can navigate, inspect, and act on any HTTP or HTTPS site without per-site approval. Commands still require an active session and a session-owned or explicitly borrowed tab. If access shows OFF, change Chrome site access once to On all sites.';

export function connectionStatusPresentation(connected: boolean): {
  label: 'Connected' | 'Disconnected';
  role: 'status';
  ariaLive: 'polite';
  ariaAtomic: 'true';
} {
  return {
    label: connected ? 'Connected' : 'Disconnected',
    role: 'status',
    ariaLive: 'polite',
    ariaAtomic: 'true',
  };
}

export function connectionActionLabel(connected: boolean, nativeEnabled: boolean): 'Disconnect' | 'Stop reconnecting' | 'Connect local host' {
  if (connected) return 'Disconnect';
  return nativeEnabled ? 'Stop reconnecting' : 'Connect local host';
}

export function isFailedRuntimeReply(reply: RuntimeReply | null | undefined): boolean {
  return reply?.ok === false;
}

export function formatPopupError(operation: string, error: unknown): string {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : '';
  const suffix = detail.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, 158 - operation.length));
  return suffix ? `${operation}: ${suffix}` : `${operation}.`;
}

function runtimeReplyError(reply: RuntimeReply | null | undefined, fallback: string): Error | null {
  if (!isFailedRuntimeReply(reply)) return null;
  const detail = typeof reply?.error === 'string' ? reply.error : reply?.error?.message;
  return new Error(typeof detail === 'string' && detail.trim() ? detail : fallback);
}

const initialState: PopupState = {
  connected: false,
  native_enabled: false,
  evaluate_enabled: false,
  takeover_requested: false,
  native_error: null,
  telemetry_consent: 'undecided',
  permissions: { meetingHosts: true, optionalSiteAccess: false, currentOriginAccess: false, allSiteAccess: false },
  sessions: [],
  active_tab: null,
};

export default function App() {
  const [state, setState] = useState(initialState);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = async (): Promise<boolean> => {
    try {
      const reply = (await browser.runtime.sendMessage({ kind: 'popup_state' })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The background state request was rejected.');
      if (failure) throw failure;
      if (
        reply.telemetry_consent !== 'accepted'
        && reply.telemetry_consent !== 'declined'
        && reply.telemetry_consent !== 'undecided'
      ) {
        throw new Error('The persisted privacy preference was unavailable.');
      }
      setState((current) => ({
        ...current,
        ...reply,
        permissions: reply.permissions ?? current.permissions,
        active_tab: reply.active_tab !== undefined ? reply.active_tab : current.active_tab,
      }));
      setHydrated(true);
      return true;
    } catch (error) {
      setNotice(formatPopupError('Unable to refresh local status', error));
      return false;
    }
  };

  useEffect(() => {
    void refresh();
    void browser.runtime.sendMessage({ kind: 'telemetry_popup_opened' });
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const setConnection = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: 'set_connection', enabled })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The local host rejected the connection change.');
      if (failure) throw failure;
      await refresh();
      if (enabled && reply.connected !== true && !reply.native_error) {
        setNotice('Local host handshake is pending; status will update when it succeeds.');
      }
    } catch (error) {
      setNotice(formatPopupError('Unable to change local connection', error));
    } finally {
      setBusy(false);
    }
  };
  const setTelemetry = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: 'set_telemetry_consent', enabled })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The privacy preference could not be saved.');
      if (failure) throw failure;
      const consent = reply.telemetry_consent;
      if (consent !== 'accepted' && consent !== 'declined') {
        throw new Error('The privacy preference was not persisted.');
      }
      setState((current) => ({ ...current, telemetry_consent: consent }));
      if (consent === 'accepted') {
        void browser.runtime.sendMessage({ kind: 'telemetry_popup_opened' });
      }
    } catch (error) {
      setNotice(formatPopupError('Unable to change anonymous usage sharing', error));
    } finally {
      setBusy(false);
    }
  };


  const setEvaluate = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: 'set_capability', capability: 'evaluate', enabled })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The page evaluation capability change was rejected.');
      if (failure) throw failure;
      if (reply.enabled !== enabled) throw new Error('The page evaluation capability was not changed.');
      setState((current) => ({ ...current, evaluate_enabled: enabled }));
    } catch (error) {
      setNotice(formatPopupError('Unable to change page evaluation', error));
    } finally {
      setBusy(false);
    }
  };

  const setTakeover = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: 'set_takeover', enabled })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The takeover change was rejected.');
      if (failure) throw failure;
      if (reply.takeover_requested !== enabled) throw new Error('The takeover change was not applied.');
      await refresh();
    } catch (error) {
      setNotice(formatPopupError('Unable to change takeover state', error));
    } finally {
      setBusy(false);
    }
  };

  const setActiveBorrowed = async (borrowed: boolean): Promise<void> => {
    setBusy(true);
    setNotice('');
    try {
      const reply = (await browser.runtime.sendMessage({ kind: borrowed ? 'popup_borrow_active' : 'popup_return_active' })) as RuntimeReply;
      const failure = runtimeReplyError(reply, 'The active tab could not be updated.');
      if (failure) throw failure;
      await refresh();
    } catch (error) {
      setNotice(formatPopupError('Unable to update the active tab', error));
    } finally {
      setBusy(false);
    }
  };

  const activeTab = state.active_tab;
  const activeTabLabel = activeTab?.title || activeTab?.url || 'No active browser tab';
  const connectionStatus = connectionStatusPresentation(state.connected);


  return (
    <main className="popup" aria-labelledby="title">
      <header className="brand">
        <img src={browser.runtime.getURL('/icon.svg')} alt="" width="32" height="32" />
        <div>
          <p className="eyebrow">LOCAL CONTROL</p>
          <h1 id="title">OverSeer Browser</h1>
        </div>
      </header>

      {hydrated && state.telemetry_consent === 'undecided' ? (
        <div className="consent-scrim">
          <section className="consent-modal" role="dialog" aria-modal="true" aria-labelledby="telemetry-consent-heading">
            <p className="eyebrow">PRIVACY CHOICE</p>
            <h2 id="telemetry-consent-heading">Help improve OverSeer Browser?</h2>
            <p className="body-copy">Share a random installation ID, app version, coarse platform/architecture, UTC day, daily launch/heartbeat, and normally one successful daily batch of coarse action totals. Usage batches carry a random lowercase UUID v4 that stays the same if delivery retries. Failed delivery may retry while sharing remains enabled. Identifier rows expire within 34 UTC days; ID-free daily totals within 360 days. URLs, titles, page content, screenshots, form values, command arguments, meeting details, and other browser content are never sent.</p>
            <div className="consent-actions">
              <button className="button secondary" type="button" onClick={() => void setTelemetry(false)} disabled={busy}>No thanks</button>
              <button className="button primary" type="button" onClick={() => void setTelemetry(true)} disabled={busy}>Share anonymous usage</button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="connection-panel" aria-labelledby="connection-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONNECTION</p>
            <h2 id="connection-heading">{state.connected ? 'Connected locally' : 'Not connected'}</h2>
          </div>
          <span
            className={`status-dot ${state.connected ? 'online' : 'offline'}`}
            role={connectionStatus.role}
            aria-label={connectionStatus.label}
            aria-live={connectionStatus.ariaLive}
            aria-atomic={connectionStatus.ariaAtomic}
          />
        </div>
        <p className="body-copy">Browser control and native-host transport stay local. Page content and screenshots are returned only for explicit commands and may be sent to the configured AI provider. Optional anonymous telemetry uses only the disclosed coarse event fields. Meeting reminders send only a minimized opaque payload locally.</p>
        <button className={state.native_enabled ? 'button secondary' : 'button primary'} type="button" onClick={() => void setConnection(!state.native_enabled)} disabled={busy}>
          {connectionActionLabel(state.connected, state.native_enabled)}
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
        <p className="body-copy">{MEETING_HOST_POLICY} A salted opaque key is sent locally; URLs, titles, participants, and page text are never included.</p>
        <p className="muted">Recording still requires an explicit confirmation in UltraVox.</p>
      </section>

      <section className="section" aria-labelledby="access-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">CAPABILITIES</p>
            <h2 id="access-heading">Site access</h2>
          </div>
          <span className={`tag ${state.permissions.allSiteAccess ? 'tag-on' : ''}`}>{state.permissions.allSiteAccess ? 'ON' : 'OFF'}</span>
        </div>
        <p className="body-copy">{SITE_ACCESS_POLICY}</p>
        <label className="capability-row">
          <input type="checkbox" checked={state.evaluate_enabled} onChange={(event) => void setEvaluate(event.target.checked)} disabled={busy} />
          <span>
            <strong>Enable page evaluation</strong>
            <small>High-risk capability. Only session-owned or explicitly borrowed tabs; requests remain local.</small>
          </span>
        </label>
      </section>

      <section className="section" aria-labelledby="privacy-heading">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">PRIVACY</p>
            <h2 id="privacy-heading">Anonymous usage</h2>
          </div>
          <span className={`tag ${state.telemetry_consent === 'accepted' ? 'tag-on' : ''}`}>{state.telemetry_consent === 'accepted' ? 'ON' : 'OFF'}</span>
        </div>
        <p className="body-copy">Optional launch, daily heartbeat, and coarse action totals only. No browsing data or user content. Turning this off deletes the local telemetry ID and pending counters.</p>
        <label className="capability-row">
          <input type="checkbox" checked={state.telemetry_consent === 'accepted'} onChange={(event) => void setTelemetry(event.target.checked)} disabled={busy} />
          <span>
            <strong>Share anonymous usage</strong>
            <small>You can change this at any time.</small>
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
      <footer>v{browser.runtime.getManifest().version} · local control, optional anonymous metrics</footer>
    </main>
  );
}
