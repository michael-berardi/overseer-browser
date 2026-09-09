import { recordingOptions } from './recording';
export const CONSENT_MS = 60_000;
export const RETENTION_MS = 5 * 60_000;
type Pending = ReturnType<typeof recordingOptions> & { session: string; tabId: number; phase: string; token: string; expires: number };
let pending: Pending | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
export async function recorderMessage(action: string, extra = {}) {
  const result = await chrome.runtime.sendMessage({ destination: 'recorder', action, ...extra });
  if (!result || result.phase === 'error') throw new Error(result?.reason || 'Recorder unavailable');
  return result;
}
export async function recordingCleanup(tabId?: number) {
  if (tabId !== undefined && pending?.tabId !== tabId) return;
  pending = undefined; clearTimeout(expiry);
  if (await chrome.offscreen.hasDocument()) {
    try { await recorderMessage('clear'); } finally { await chrome.offscreen.closeDocument(); }
  }
}
function expire() {
  if (pending?.phase === 'consent_required' && Date.now() >= pending.expires) {
    pending.phase = 'expired';
    // Consent has no media; eagerly discard any prior recorder buffers.
    void recorderMessage('clear').catch(() => {});
  }
}
export async function recordCommand(action: string, session: string, tabId: number, params: Record<string, unknown>) {
  expire();
  if (pending && pending.session !== session) throw new Error('recording_wrong_session');
  if (action === 'start' || action === 'restart') {
    const options = recordingOptions(params);
    if (pending && ['preparing', 'approving'].includes(pending.phase)) throw new Error('Recorder busy');
    if (pending && action === 'start') throw new Error('recording_exists: stop/export/clear or restart');
    // Reserve ownership before the first await, preventing competing start requests.
    const request: Pending = { ...options, session, tabId, phase: 'preparing', token: crypto.randomUUID(), expires: Date.now() + CONSENT_MS };
    pending = request; clearTimeout(expiry);
    try {
      if (await chrome.offscreen.hasDocument()) await recorderMessage('clear');
      else await chrome.offscreen.createDocument({ url: 'recorder.html', reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: 'Explicitly approved owned-tab video capture' });
      if (pending !== request) throw new Error('Consent cancelled');
      request.phase = 'consent_required';
      expiry = setTimeout(expire, CONSENT_MS);
      return { ...request, operator_action: 'Open toolbar popup on requested tab and approve. Restart always requires fresh consent.' };
    } catch (e) { if (pending === request) pending.phase = 'error'; throw e; }
  }
  if (!pending) return { phase: 'idle' };
  if (action === 'clear') { await recordingCleanup(); return { phase: 'idle' }; }
  if (action === 'stop' && ['consent_required', 'approving'].includes(pending.phase)) {
    pending.phase = 'cancelled';
    await recorderMessage('clear');
  }
  if (!['recording', 'stopped'].includes(pending.phase)) return pending;
  const request = pending;
  const result = await recorderMessage(action, { ...request, index: params.index });
  if (pending === request && result.phase) request.phase = result.phase;
  return result;
}
export async function recordingPopup(message: any, validate: (p: Pending) => Promise<boolean>) {
  expire();
  if (message.kind === 'record_pending') return pending?.phase === 'consent_required' && await validate(pending) ? pending : null;
  const request = pending;
  if (!request || message.token !== request.token || request.phase !== 'consent_required') throw new Error('No matching consent request');
  if (!await validate(request)) { request.phase = 'cancelled'; throw new Error('Target ownership/active tab changed'); }
  expire();
  if (pending !== request || request.phase !== 'consent_required') throw new Error('Consent cancelled');
  if (message.kind === 'record_deny') { request.phase = 'denied'; await recorderMessage('clear'); return request; }
  if (message.kind !== 'record_approve') throw new Error('Invalid consent action');
  request.phase = 'approving';
  try {
    const streamId = await new Promise<string>((resolve, reject) => chrome.tabCapture.getMediaStreamId({targetTabId: request.tabId}, id => {
      if (chrome.runtime.lastError || !id) reject(new Error(chrome.runtime.lastError?.message || 'Capture denied')); else resolve(id);
    }));
    if (pending !== request || request.phase !== 'approving' || Date.now() >= request.expires || !await validate(request)) throw new Error('Consent cancelled');
    const result = await recorderMessage('start', { ...request, streamId });
    if (pending !== request || request.phase !== 'approving') { await recorderMessage('clear'); throw new Error('Consent cancelled'); }
    request.phase = result.phase;
    clearTimeout(expiry);
    expiry = setTimeout(() => { void recordingCleanup().catch(() => {}); }, request.seconds * 1000 + RETENTION_MS);
    return result;
  } catch (e) { if (pending === request) request.phase = 'denied'; throw e; }
}
