import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInIsolatedWorld } from '../src/automation';

// A rich-text editor (Draft.js on X, Lexical, ProseMirror) keeps its own model.
// It consumes paste events, and it applies execCommand('insertText') twice
// (its beforeinput handler plus the native DOM edit). The fixture reproduces
// both behaviours so the test fails if fill/type go back to execCommand first.
class TestClipboardEvent extends Event {
  clipboardData: { getData: (type: string) => string } | null;
  constructor(type: string, init: EventInit & { clipboardData?: { getData: (type: string) => string } | null }) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}
class TestDataTransfer {
  private data = new Map<string, string>();
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ''; }
}

function fixture(acceptsPaste: boolean) {
  const doc = {
    nodeType: 9,
    activeElement: null as unknown,
    body: null as unknown,
    documentElement: null as unknown,
    defaultView: null as unknown,
    selectAll: false,
    getSelection: () => ({
      rangeCount: 0,
      getRangeAt: () => null,
      removeAllRanges: () => {},
      addRange: (range: { all: boolean }) => { doc.selectAll = range.all; },
    }),
    createRange: () => {
      const range = { all: false, selectNodeContents: () => { range.all = true; }, collapse: () => { range.all = false; } };
      return range;
    },
    execCommand: (_command: string, _ui: boolean, data: string) => {
      editor.model = doc.selectAll ? `${data}${data}` : `${editor.model}${data}${data}`;
      return true;
    },
    dispatchEvent: () => true,
  };
  class EditorFixture extends EventTarget {
    tagName = 'DIV';
    isContentEditable = true;
    model = '';
    ownerDocument = doc;
    parentElement = null;
    shadowRoot = null;
    get textContent() { return this.model; }
    set textContent(value: string) { this.model = value; }
    focus() { doc.activeElement = this; }
    getAttribute() { return null; }
    setAttribute() {}
    hasAttribute() { return false; }
    getRootNode() { return doc; }
    getBoundingClientRect() { return { width: 100, height: 30 }; }
    closest() { return null; }
    contains() { return true; }
  }
  const editor = new EditorFixture();
  if (acceptsPaste) {
    editor.addEventListener('paste', (event) => {
      const text = (event as TestClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      editor.model = doc.selectAll ? text : `${editor.model}${text}`;
      event.preventDefault();
    });
  }
  const view = {
    HTMLElement: EditorFixture,
    Event,
    InputEvent: Event,
    MouseEvent: Event,
    KeyboardEvent: Event,
    ClipboardEvent: TestClipboardEvent,
    DataTransfer: TestDataTransfer,
    frameElement: null,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  doc.defaultView = view;
  doc.body = new EditorFixture();
  doc.documentElement = new EditorFixture();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', view);
  vi.stubGlobal('Node', { DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async (injection: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
    if (injection.func.name === 'installDialogGuards') return [{ result: true }];
    if (injection.func.name === 'collectDialogGuards') return [{ result: [] }];
    return [{ result: await injection.func(injection.args?.[0], null) }];
  }) } });
  return { editor, stamp: (ref: string) => { (editor as unknown as { getAttribute: (n: string) => string | null }).getAttribute = (n: string) => (n === 'data-overseer-ref' ? ref : null); } };
}

afterEach(() => vi.unstubAllGlobals());

describe('fill and type in rich-text editors', () => {
  it('inserts the text once when the editor consumes a paste', async () => {
    const { editor, stamp } = fixture(true);
    stamp('osr-editor');
    vi.stubGlobal('document', Object.assign(document, { querySelector: () => editor, querySelectorAll: () => [editor] }));
    await runInIsolatedWorld(7, { kind: 'type', ref: 'osr-editor', text: 'hello' });
    expect(editor.model).toBe('hello');
    await runInIsolatedWorld(7, { kind: 'fill', ref: 'osr-editor', value: 'replaced' });
    expect(editor.model).toBe('replaced');
  });

  it('falls back to native insertion when the editor ignores the paste', async () => {
    const { editor, stamp } = fixture(false);
    stamp('osr-editor');
    vi.stubGlobal('document', Object.assign(document, { querySelector: () => editor, querySelectorAll: () => [editor] }));
    await runInIsolatedWorld(7, { kind: 'fill', ref: 'osr-editor', value: 'x' });
    // The fixture's execCommand doubles on purpose; reaching it proves the fallback ran.
    expect(editor.model).toBe('xx');
  });
});
