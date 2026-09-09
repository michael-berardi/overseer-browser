import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Popup root is missing.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Only a real popup click can invoke tabCapture; never synthesize approval.
void chrome.runtime.sendMessage({kind: 'record_pending'}).then(p => {
  if (!p) return;
  const box = document.createElement('section');
  const label = document.createElement('p'); label.textContent = `Record owned tab ${p.tabId} for session ${p.session}: up to ${p.seconds}s at requested ${p.fps} FPS (no audio).`; box.append(label);
  for (const approve of [true, false]) {
    const button = document.createElement('button'); button.textContent = approve ? 'Approve recording' : 'Deny recording';
    button.onclick = async () => {
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({kind: approve ? 'record_approve' : 'record_deny', token: p.token});
        label.textContent = JSON.stringify(result);
      } catch (e) { label.textContent = String(e); await chrome.runtime.sendMessage({kind: 'record_deny', token: p.token}); }
    }; box.append(button);
  }
  document.body.prepend(box);
});
