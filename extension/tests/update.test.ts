import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UPDATE_ACTIONS } from '../src/protocol';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('update contract wiring', () => {
  it('asks only the local host for update status; the extension makes no network call', () => {
    const background = read('../entrypoints/background.ts');
    expect(background).toContain("kind: 'update_check', request_id: UPDATE_CHECK_ID, action");
    expect(background).toContain("value.kind === 'update_action' && isUpdateAction(value.action)");
    expect(background).not.toMatch(/\b(?:fetch|XMLHttpRequest|axios)\s*\(/);
  });

  it('keeps the popup actions identical to what the native host accepts', () => {
    const native = read('../../native_host/protocol.py');
    const updates = read('../../cli/updates.py');
    const literal = `(${UPDATE_ACTIONS.map((action) => `"${action}"`).join(', ')})`;
    expect(native).toContain(`UPDATE_ACTIONS = ${literal}`);
    expect(updates).toContain(`POPUP_ACTIONS = ${literal}`);
  });

  it('lays out Settings > Updates as toggles plus one version and Check Now row', () => {
    const app = read('../entrypoints/popup/App.tsx');
    const order = ['Install Update', 'Skip This Version', 'Remind Me Later', 'Check for updates automatically',
      'Install updates automatically', 'Version {update?.current', 'Check Now'].map((text) => app.indexOf(text));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const styles = read('../entrypoints/popup/styles.css');
    expect(styles).toContain('.update-row { display: flex; align-items: center; justify-content: space-between;');
    expect(styles).toContain('.update-actions { display: flex; justify-content: flex-end;');
  });
});
