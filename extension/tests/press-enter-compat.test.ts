import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInIsolatedWorld } from '../src/automation';

class TestKeyboardEvent extends Event {
  key: string;
  code: string;
  keyCode: number;
  constructor(type: string, init: KeyboardEventInit) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.keyCode = init.keyCode ?? 0;
  }
}

function fixture(hasForm = false) {
  let submits = 0;
  const form = { requestSubmit: () => { submits += 1; } };
  const doc = { nodeType: 9, activeElement: null as ElementFixture | null, body: null as ElementFixture | null, documentElement: null as ElementFixture | null, defaultView: null as unknown };
  class ElementFixture extends EventTarget {
    tagName = 'INPUT';
    ownerDocument = doc;
    parentElement = null;
    shadowRoot = null;
    focus() { doc.activeElement = this; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    getRootNode() { return doc; }
    getBoundingClientRect() { return { width: 100, height: 30 }; }
    closest() { return hasForm ? form : null; }
  }
  const input = new ElementFixture();
  doc.activeElement = input;
  doc.body = new ElementFixture();
  doc.body.tagName = 'BODY';
  doc.documentElement = new ElementFixture();
  const view = { HTMLElement: ElementFixture, KeyboardEvent: TestKeyboardEvent, Event, frameElement: null, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
  doc.defaultView = view;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', view);
  vi.stubGlobal('Node', { DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async (injection: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
    if (injection.func.name === 'installDialogGuards') return [{ result: true }];
    if (injection.func.name === 'collectDialogGuards') return [{ result: [] }];
    // Exercise the real isolated executor; no page dialogs exist in this fixture.
    return [{ result: await injection.func(injection.args?.[0], null) }];
  }) } });
  return { input, submits: () => submits };
}

afterEach(() => vi.unstubAllGlobals());

describe('Enter compatibility in the real isolated press executor', () => {
  it('supplies keyCode13 to legacy handlers without claiming trusted input', async () => {
    const { input } = fixture();
    const events: TestKeyboardEvent[] = [];
    input.addEventListener('keydown', (event) => events.push(event as TestKeyboardEvent));
    await runInIsolatedWorld(7, { kind: 'press', key: 'Enter' });
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('Enter');
    expect(events[0].code).toBe('Enter');
    expect(events[0].keyCode).toBe(13);
    expect(events[0].isTrusted).toBe(false);
  });
  it('honors a legacy handler cancelling Enter rather than submitting again', async () => {
    const { input, submits } = fixture(true);
    input.addEventListener('keydown', (event) => {
      if ((event as TestKeyboardEvent).keyCode === 13) event.preventDefault();
    });
    await runInIsolatedWorld(7, { kind: 'press', key: 'Enter' });
    expect(submits()).toBe(0);
  });
  it('retains one default submission for an unhandled Enter', async () => {
    const { submits } = fixture(true);
    await runInIsolatedWorld(7, { kind: 'press', key: 'Enter' });
    expect(submits()).toBe(1);
  });
});
