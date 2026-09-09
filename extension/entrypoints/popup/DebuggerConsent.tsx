import { useEffect, useState } from 'react';
import { DEBUGGER_INSTRUCTIONS, debuggerOrigin } from '../../src/debugger_bridge';
export function DebuggerConsent({ tab }: { tab: { id: number; session_key?: string; url?: string } | null }) {
  const [message, setMessage] = useState('Debugger denied by default.');
  const [permission, setPermission] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  let origin = '';
  try { origin = debuggerOrigin(tab?.url); } catch {}
  const refresh = async () => {
    const enabled = chrome.runtime.getManifest().permissions?.includes('debugger') === true;
    setPermission(enabled && await chrome.permissions.contains({ permissions: ['debugger'] }));
    setAuthorized(false);
    if (tab?.session_key) {
      const reply = await chrome.runtime.sendMessage({ kind: 'debugger_status', tab_id: tab.id, session_key: tab.session_key });
      setAuthorized(reply?.authorized === true);
    }
  };
  useEffect(() => { void refresh().catch(() => {}); }, [tab?.id, tab?.session_key, origin]);
  const act = async (kind: string) => {
    setBusy(true);
    try {
      const reply = await chrome.runtime.sendMessage({ kind, tab_id: tab?.id, session_key: tab?.session_key, origin });
      if (!reply?.ok) throw new Error(String(reply?.error ?? 'Debugger request failed.'));
      setMessage(kind === 'debugger_authorize' ? 'Only this tab is authorized for up to 5 minutes. Attachment occurs only when used.' : 'Debugger consent revoked.');
      await refresh();
    } catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  };
  return <section aria-label="Debugger tab consent">
    <h2>Trusted input / deeper network (staged)</h2>
    <p>{DEBUGGER_INSTRUCTIONS}</p>
    <p>No bodies, cookies, authorization headers or network modification. All header values are redacted. No real DevTools compatibility QA yet.</p>
    <p>One tab: {tab?.id ?? 'none'} · Session: {tab?.session_key ?? 'not controlled'} · {origin || 'unsupported page'}</p>
    <p>{authorized ? 'This tab authorized' : 'This tab NOT authorized'}</p>
    {!permission && <p>Unavailable in this build. Chrome requires an installation permission; separate operator approval is pending.</p>}
    <button disabled={busy || !permission || !tab?.session_key || !origin || authorized} onClick={() => void act('debugger_authorize')}>Authorize ONLY this tab/session/origin</button>
    <button disabled={busy || !tab?.session_key} onClick={() => void act('debugger_revoke')}>Revoke this tab</button>
    <button disabled={busy} onClick={() => void act('debugger_remove')}>Revoke all debugger tab consent</button>
    <p role="status">{message}</p>
  </section>;
}
