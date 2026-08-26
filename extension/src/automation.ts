import { MAX_UPLOAD_BYTES } from './protocol';
import type { WaitCondition } from './wait';

export type AutomationUploadFile = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type AutomationAction =
  | { kind: 'snapshot' | 'observe'; maxNodes?: number }
  | { kind: 'click' | 'hover'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'press'; ref?: string; key: string; code?: string }
  | { kind: 'scroll'; ref?: string; x?: number; y?: number }
  | { kind: 'element_rect'; ref: string }
  | { kind: 'viewport' }
  | { kind: 'upload'; ref: string; files: AutomationUploadFile[] };

export interface SnapshotNode {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  disabled?: boolean;
  href?: string;
}

export interface RectResult {
  left: number;
  top: number;
  width: number;
  height: number;
}

type ExecutionError = { code: string; message: string; fallback?: string };
type ExecutionEnvelope = { ok: true; value: unknown } | { ok: false; error: ExecutionError };

export interface CapturedDialog {
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  defaultValue?: string;
  response: boolean | string | null;
}

function isExecutionEnvelope(value: unknown): value is ExecutionEnvelope {
  if (!value || typeof value !== 'object' || !('ok' in value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return 'value' in value;
  if (!('error' in value) || !value.error || typeof value.error !== 'object') return false;
  const error = value.error as Record<string, unknown>;
  return typeof error.code === 'string' && typeof error.message === 'string' &&
    (error.fallback === undefined || typeof error.fallback === 'string');
}

const ACTIONABLE_TAGS: Record<string, true> = { button: true, input: true, select: true, textarea: true, summary: true };
const ACTIONABLE_ROLES: Record<string, true> = { button: true, checkbox: true, combobox: true, link: true, menuitem: true, option: true, radio: true, searchbox: true, slider: true, spinbutton: true, switch: true, tab: true, textbox: true };
const SEMANTIC_TAGS: Record<string, true> = { address: true, article: true, aside: true, details: true, figcaption: true, figure: true, footer: true, form: true, header: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, main: true, nav: true, section: true, table: true };

export function snapshotPriorityForNode(node: Pick<SnapshotNode, 'tag' | 'role' | 'name' | 'href'>): 0 | 1 | 2 {
  const tag = node.tag.toLowerCase();
  const role = node.role?.toLowerCase();
  if (ACTIONABLE_TAGS[tag] || (tag === 'a' && Boolean(node.href)) || (role !== undefined && ACTIONABLE_ROLES[role])) return 0;
  if (role || node.name || SEMANTIC_TAGS[tag]) return 1;
  return 2;
}

export async function runInIsolatedWorld(tabId: number, action: AutomationAction): Promise<unknown> {
  if (action.kind === 'upload' && !isBoundedUpload(action)) {
    const decodedBytes = decodedUploadBytes(action);
    if (decodedBytes !== null && decodedBytes > MAX_UPLOAD_BYTES) {
      throw new AutomationError('upload_too_large', 'Upload exceeds the 8 MiB extension limit.');
    }
    throw new AutomationError('invalid_upload', 'Upload metadata or content is invalid.');
  }
  const dialogToken = action.kind === 'click' || (action.kind === 'press' && ['Enter', ' ', 'Spacebar'].includes(action.key))
    ? `overseer-dialog-${crypto.randomUUID()}`
    : undefined;
  if (dialogToken !== undefined) {
    const [installed] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installDialogGuards,
      args: [dialogToken],
    });
    if (installed?.result !== true) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: collectDialogGuards,
          args: [dialogToken],
        });
      } catch {
        // The page may have navigated while the partial guard set was being removed.
      }
      throw new AutomationError('dialog_guard_failed', 'Browser dialog protection could not be installed in the target tab.');
    }
  }
  let dialogs: CapturedDialog[] = [];
  let injection: chrome.scripting.InjectionResult<unknown> | undefined;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: isolatedAutomation,
      args: [action, dialogToken ?? null],
    });
  } finally {
    if (dialogToken !== undefined) {
      try {
        const [captured] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: collectDialogGuards,
          args: [dialogToken],
        });
        if (Array.isArray(captured?.result)) dialogs = captured.result as CapturedDialog[];
      } catch {
        // The action may have navigated or closed the document after its in-page cleanup signal.
      }
    }
  }
  const envelope = injection?.result;
  if (!isExecutionEnvelope(envelope)) {
    throw new AutomationError('automation_failed', 'Browser automation failed in the target tab.');
  }
  if (!envelope.ok) throw new AutomationError(envelope.error.code, envelope.error.message, envelope.error.fallback);
  if (dialogs.length > 0 && envelope.value && typeof envelope.value === 'object' && !Array.isArray(envelope.value)) {
    return { ...envelope.value as Record<string, unknown>, dialogs };
  }
  return envelope.value;
}

export async function runPageEvaluation(tabId: number, source: string): Promise<unknown> {
  if (source.length === 0 || source.length > 32_000) {
    throw new AutomationError('invalid_evaluate', 'Evaluate source must be between 1 and 32000 characters.');
  }
  const program = `(async () => {
    let resolved;
    try {
      resolved = await (${source});
    } catch {
      return { ok: false, error: { code: 'evaluation_failed', message: 'Page evaluation failed in the target tab.' } };
    }
    if (resolved === undefined) return { ok: true, value: null };
    let serialized;
    try {
      serialized = JSON.stringify(resolved);
    } catch {
      return { ok: false, error: { code: 'evaluation_result_invalid', message: 'Page evaluation must return a JSON-serializable value.' } };
    }
    if (serialized === undefined) {
      return { ok: false, error: { code: 'evaluation_result_invalid', message: 'Page evaluation must return a JSON-serializable value.' } };
    }
    if (serialized.length > 512000) {
      return { ok: false, error: { code: 'evaluation_result_too_large', message: 'Page evaluation result exceeds the 512000-character limit.' } };
    }
    return { ok: true, value: JSON.parse(serialized) };
  })()`;
  let injections: chrome.userScripts.InjectionResult[];
  try {
    injections = await chrome.userScripts.execute({
      target: { tabId },
      world: 'USER_SCRIPT',
      js: [{ code: program }],
    });
  } catch {
    throw new AutomationError(
      'user_scripts_required',
      'Page evaluation requires Chrome user-script access.',
      'Enable Allow User Scripts for OverSeer Browser in Chrome extension settings.',
    );
  }
  const envelope = injections[0]?.result;
  if (!isExecutionEnvelope(envelope)) {
    throw new AutomationError('evaluation_failed', 'Page evaluation failed in the target tab.');
  }
  if (!envelope.ok) throw new AutomationError(envelope.error.code, envelope.error.message, envelope.error.fallback);
  return envelope.value;
}

/**
 * Run one bounded, event-driven wait in the target tab. The in-page observer
 * always self-cleans at `timeoutMs`, which the caller caps at the remaining
 * request deadline so cancellation never leaves a detached observer.
 */
export async function runWaitFor(tabId: number, condition: WaitCondition, timeoutMs: number): Promise<unknown> {
  let injection: chrome.scripting.InjectionResult<unknown> | undefined;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: isolatedWaitFor,
      args: [condition, timeoutMs],
    });
  } catch {
    throw new AutomationError('wait_interrupted', 'The wait was interrupted because the target document navigated or closed.', 'Observe the current page and retry the wait.');
  }
  const envelope = injection?.result;
  if (!isExecutionEnvelope(envelope)) {
    throw new AutomationError('wait_failed', 'The wait could not run in the target tab.');
  }
  if (!envelope.ok) throw new AutomationError(envelope.error.code, envelope.error.message, envelope.error.fallback);
  return envelope.value;
}

async function isolatedWaitFor(condition: WaitCondition, timeoutMs: number): Promise<ExecutionEnvelope> {
  const waitVisible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) return false;
    let ancestor = element.parentElement;
    while (ancestor) {
      const ancestorStyle = window.getComputedStyle(ancestor);
      if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity) === 0) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  };
  const fail = (code: string, message: string, fallback?: string): ExecutionEnvelope => ({ ok: false, error: { code, message, ...(fallback ? { fallback } : {}) } });
  const matches = (): boolean => {
    if (condition.type === 'text') {
      const present = (document.body?.textContent ?? '').includes(condition.text);
      return condition.absent ? !present : present;
    }
    if (condition.type === 'selector') {
      let element: Element | null;
      try {
        element = document.querySelector(condition.selector);
      } catch {
        throw { overseerWaitInvalidSelector: true };
      }
      if (condition.state === 'hidden') return element === null || !waitVisible(element);
      if (element === null) return false;
      if (condition.state === 'enabled') {
        const disabled = element.getAttribute('aria-disabled') === 'true' ||
          ('disabled' in element && Boolean((element as HTMLButtonElement).disabled));
        return waitVisible(element) && !disabled;
      }
      return waitVisible(element);
    }
    return false;
  };
  // Executor form: the shipped tsconfig pins ES2022, before Promise.withResolvers.
  let resolveWait!: (envelope: ExecutionEnvelope) => void;
  const promise = new Promise<ExecutionEnvelope>((resolvePromise) => {
    resolveWait = resolvePromise;
  });
  let settled = false;
  let observer: MutationObserver | undefined;
  let quietTimer: number | undefined;
  const finish = (envelope: ExecutionEnvelope): void => {
    if (settled) return;
    settled = true;
    observer?.disconnect();
    clearTimeout(quietTimer);
    clearTimeout(deadline);
    resolveWait(envelope);
  };
  const deadline = setTimeout(() => {
    finish(fail('wait_timeout', 'The wait condition was not met before its timeout.', 'Observe the page to inspect its current state, then retry with a longer timeout_ms.'));
  }, timeoutMs);
  try {
    if (condition.type === 'dom_stable') {
      const arm = (): void => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish({ ok: true, value: { matched: true, stable_ms: condition.quietMs } }), condition.quietMs) as unknown as number;
      };
      observer = new MutationObserver(arm);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      arm();
    } else {
      // MutationObserver callbacks already batch per microtask; each batch
      // re-checks the condition once. ponytail: full-body textContent scan per
      // batch; add throttling if chatty pages measurably stall waits.
      observer = new MutationObserver(() => {
        try {
          if (matches()) finish({ ok: true, value: { matched: true } });
        } catch {
          finish(fail('invalid_selector', 'The wait selector is not a valid CSS selector.'));
        }
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      if (matches()) finish({ ok: true, value: { matched: true } });
    }
  } catch {
    finish(fail('invalid_selector', 'The wait selector is not a valid CSS selector.'));
  }
  return promise;
}

export function stableRefForPath(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `osr-${(hash >>> 0).toString(36)}`;
}

function decodedBase64Bytes(contentBase64: unknown): number | null {
  if (typeof contentBase64 !== 'string' || contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) return null;
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
  if (padding > 0 && contentBase64.length < 4) return null;
  return contentBase64.length / 4 * 3 - padding;
}

function decodedUploadBytes(action: unknown): number | null {
  if (!action || typeof action !== 'object' || !('files' in action) || !Array.isArray(action.files)) return null;
  let total = 0;
  for (const file of action.files) {
    if (!file || typeof file !== 'object' || !('contentBase64' in file)) return null;
    const bytes = decodedBase64Bytes(file.contentBase64);
    if (bytes === null) return null;
    total += bytes;
  }
  return total;
}

function isSafeUploadFile(file: unknown): file is AutomationUploadFile {
  if (!file || typeof file !== 'object' || !('filename' in file) || !('mimeType' in file) || !('contentBase64' in file)) return false;
  if (typeof file.filename !== 'string' || typeof file.mimeType !== 'string' || typeof file.contentBase64 !== 'string') return false;
  const filenameBytes = new TextEncoder().encode(file.filename).byteLength;
  if (filenameBytes < 1 || filenameBytes > 255) return false;
  if (file.filename === '.' || file.filename === '..') return false;
  if (/[/\\\u0000-\u001f\u007f]/.test(file.filename)) return false;
  if (file.mimeType.length < 1 || file.mimeType.length > 128) return false;
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) return false;
  return decodedBase64Bytes(file.contentBase64) !== null;
}
export function isBoundedUpload(action: Extract<AutomationAction, { kind: 'upload' }>): boolean {
  if (!action || !Array.isArray(action.files) || action.files.length < 1 || action.files.length > 16) return false;
  let totalBytes = 0;
  for (const file of action.files) {
    if (!isSafeUploadFile(file)) return false;
    const bytes = decodedBase64Bytes(file.contentBase64);
    if (bytes === null) return false;
    totalBytes += bytes;
    if (totalBytes > MAX_UPLOAD_BYTES) return false;
  }
  return true;
}

export class AutomationError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'AutomationError';
  }
}

/**
 * Serialized into the target tab by chrome.scripting.executeScript; it must stay
 * fully self-contained (no module-scope references). Mutation actions additionally
 * report a bounded count of DOM mutations observed during the action plus one
 * macrotask flush, so callers can tell whether the page reacted without a full
 * re-observation. The count covers only synchronous/microtask page reactions;
 * later async work is observed through observe or wait.for.
 */
async function isolatedAutomation(action: AutomationAction, dialogToken: string | null): Promise<ExecutionEnvelope> {
  const MUTATION_EVIDENCE_KINDS: Record<string, true> = {
    click: true, hover: true, fill: true, type: true, select: true, press: true, scroll: true, upload: true,
  };
  const MUTATION_EVIDENCE_CAP = 10_000;
  type LocalFailure = { overseerAutomationFailure: true; code: string; message: string; fallback?: string };
  const succeed = (value: unknown): ExecutionEnvelope => ({ ok: true, value });
  const fail = (code: string, message: string, fallback?: string): never => {
    throw { overseerAutomationFailure: true, code, message, fallback } satisfies LocalFailure;
  };
  const stableRef = (path: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `osr-${(hash >>> 0).toString(36)}`;
  };
  type RealmWindow = Window & typeof globalThis;
  const tagOf = (element: Element): string => element.tagName.toLowerCase();
  const elementWindow = (element: Element): RealmWindow => (element.ownerDocument.defaultView ?? window) as RealmWindow;
  const isHtmlElement = (element: Element): element is HTMLElement => {
    const view = elementWindow(element);
    return element instanceof view.HTMLElement;
  };
  const isShadowRoot = (root: Node): root is ShadowRoot => root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root;
  function composedAncestor(element: Element): Element | null {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    if (isShadowRoot(root)) return root.host;
    try {
      return element.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  }
  // Visibility verdicts are memoized per synchronous automation pass: page
  // style cannot change mid-pass, and sibling subtrees share ancestor chains.
  // A cached `false` is final; a cached `true` from a descendant's ancestor
  // walk is confirmed by this element's own style/rect checks below.
  const visibilityCache = new WeakMap<Element, boolean>();
  const visible = (element: Element): element is HTMLElement => {
    if (visibilityCache.get(element) === false) return false;
    if (!isHtmlElement(element)) return false;
    const style = elementWindow(element).getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) {
      visibilityCache.set(element, false);
      return false;
    }
    if (visibilityCache.get(element) === true) return true;
    let verdict = true;
    const path: Element[] = [];
    let ancestor = composedAncestor(element);
    while (ancestor) {
      const cachedAncestor = visibilityCache.get(ancestor);
      if (cachedAncestor !== undefined) {
        verdict = cachedAncestor;
        break;
      }
      path.push(ancestor);
      if (!isHtmlElement(ancestor)) {
        verdict = false;
        break;
      }
      const ancestorStyle = elementWindow(ancestor).getComputedStyle(ancestor);
      if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity) === 0) {
        verdict = false;
        break;
      }
      if (tagOf(ancestor) === 'iframe') {
        const ancestorRect = ancestor.getBoundingClientRect();
        if (ancestorRect.width <= 0 || ancestorRect.height <= 0) {
          verdict = false;
          break;
        }
      }
      ancestor = composedAncestor(ancestor);
    }
    // Every walked ancestor shares this chain's outcome up to the verdict
    // point; a later direct call on one still re-checks its own style/rect.
    for (const item of path) visibilityCache.set(item, verdict);
    visibilityCache.set(element, verdict);
    return verdict;
  };
  const allElements = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (isHtmlElement(element)) nodes.push(element);
        if (isHtmlElement(element) && element.shadowRoot) visit(element.shadowRoot);
        if (tagOf(element) === 'iframe' && visible(element)) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument) visit(frameDocument);
          } catch {
            // Cross-origin frames are intentionally opaque.
          }
        }
      }
    };
    visit(document);
    return nodes;
  };
  const pathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      if (current.parentElement) {
        let index = 0;
        let sibling = current.previousElementSibling;
        while (sibling) {
          index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.push(`${tagOf(current)}:${index}`);
        current = current.parentElement;
        continue;
      }
      const root = current.getRootNode();
      if (isShadowRoot(root)) {
        let index = 0;
        let sibling = current.previousElementSibling;
        while (sibling) {
          index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.push(`${tagOf(current)}:${index}`, '#shadow');
        current = root.host;
        continue;
      }
      try {
        const frameElement: Element | null = current.ownerDocument.defaultView?.frameElement ?? null;
        if (frameElement) {
          parts.push('#frame');
          current = frameElement;
          continue;
        }
      } catch {
        // Only same-origin frames are traversed, but keep the boundary defensive.
      }
      break;
    }
    return parts.reverse().join('/');
  };
  const refFor = (element: Element): string => {
    const existing = element.getAttribute('data-overseer-ref');
    if (existing && /^osr-[a-z0-9]+$/.test(existing)) return existing;
    const ref = stableRef(pathFor(element));
    element.setAttribute('data-overseer-ref', ref);
    return ref;
  };
  const findByRef = (ref: string): HTMLElement => {
    const elements = allElements();
    for (const element of elements) {
      if (element.getAttribute('data-overseer-ref') === ref) return element;
    }
    for (const element of elements) {
      if (stableRef(pathFor(element)) === ref) {
        element.setAttribute('data-overseer-ref', ref);
        return element;
      }
    }
    return fail('stale_ref', 'The element reference is no longer present in the target document.', 'Observe the page again and retry with a current ref.');
  };
  const disabledOrInert = (element: HTMLElement): boolean => {
    if (element.getAttribute('aria-disabled') === 'true' || ('disabled' in element && Boolean((element as HTMLButtonElement).disabled))) return true;
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute('inert')) return true;
      current = composedAncestor(current);
    }
    return false;
  };
  const requireInteractable = (element: HTMLElement): void => {
    if (!visible(element)) fail('element_not_interactable', 'The target element is hidden or has no rendered bounds.', 'Observe the page after it becomes visible.');
    if (disabledOrInert(element)) fail('element_disabled', 'The target element is disabled or inert.');
  };
  const scrollIntoTopViewport = (element: HTMLElement): void => {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    let currentDocument = element.ownerDocument;
    while (currentDocument.defaultView?.frameElement) {
      const frame = currentDocument.defaultView.frameElement as HTMLElement;
      frame.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      currentDocument = frame.ownerDocument;
    }
  };
  const topViewportRect = (element: HTMLElement): RectResult => {
    const rect = element.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    let width = rect.width;
    let height = rect.height;
    let currentDocument = element.ownerDocument;
    while (currentDocument.defaultView?.frameElement) {
      const frame = currentDocument.defaultView.frameElement as HTMLElement;
      const frameRect = frame.getBoundingClientRect();
      const scaleX = frame.offsetWidth > 0 ? frameRect.width / frame.offsetWidth : 1;
      const scaleY = frame.offsetHeight > 0 ? frameRect.height / frame.offsetHeight : 1;
      left = frameRect.left + frame.clientLeft * scaleX + left * scaleX;
      top = frameRect.top + frame.clientTop * scaleY + top * scaleY;
      width *= scaleX;
      height *= scaleY;
      currentDocument = frame.ownerDocument;
    }
    return { left, top, width, height };
  };
  const deepActiveElement = (): HTMLElement => {
    let active: Element | null = document.activeElement;
    while (active) {
      if (isHtmlElement(active) && active.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
        continue;
      }
      if (tagOf(active) === 'iframe') {
        try {
          const frameActive = (active as HTMLIFrameElement).contentDocument?.activeElement;
          if (frameActive) {
            active = frameActive;
            continue;
          }
        } catch {
          // Cross-origin active frames remain represented by their frame element.
        }
      }
      break;
    }
    return active && isHtmlElement(active) ? active : document.body;
  };
  const focusNext = (current: HTMLElement): void => {
    const candidates = allElements().filter((candidate) => (
      ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tagOf(candidate)) || candidate.hasAttribute('tabindex')
    )).filter((candidate) => visible(candidate) && candidate.tabIndex >= 0 && !disabledOrInert(candidate));
    if (candidates.length === 0) return;
    const currentIndex = candidates.indexOf(current);
    candidates[(currentIndex + 1) % candidates.length]?.focus();
  };
  const setTextValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const view = elementWindow(element);
    const prototype = tagOf(element) === 'input' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) {
      throw { overseerAutomationFailure: true, code: 'element_not_editable', message: 'The target text value setter is unavailable.' } satisfies LocalFailure;
    }
    setter.call(element, value);
  };
  const insertContentEditableText = (element: HTMLElement, data: string, replaceAll: boolean): boolean => {
    const ownerDocument = element.ownerDocument;
    const selection = ownerDocument.getSelection();
    if (!selection) return false;
    const range = ownerDocument.createRange();
    const currentRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (replaceAll) {
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (!currentRange || !element.contains(currentRange.commonAncestorContainer)) {
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (typeof ownerDocument.execCommand !== 'function') return false;
    try {
      return ownerDocument.execCommand('insertText', false, data);
    } catch {
      return false;
    }
  };
  const signalDialogCleanup = (): void => {
    if (dialogToken === null) return;
    const visit = (targetDocument: Document): void => {
      const view = (targetDocument.defaultView ?? window) as RealmWindow;
      targetDocument.dispatchEvent(new view.Event(dialogToken));
      for (const frame of Array.from(targetDocument.querySelectorAll('iframe'))) {
        try {
          if (frame.contentDocument) visit(frame.contentDocument);
        } catch {
          // Cross-origin child documents remain opaque.
        }
      }
    };
    visit(document);
  };
  const execute = (): ExecutionEnvelope => {
    try {
      if (action.kind === 'snapshot' || action.kind === 'observe') {
        const maxNodes = Math.min(Math.max(action.maxNodes ?? 200, 1), 500);
        const actionableTags = ['button', 'input', 'select', 'textarea', 'summary'];
        const actionableRoles = ['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox'];
        const semanticTags = ['address', 'article', 'aside', 'details', 'figcaption', 'figure', 'footer', 'form', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'main', 'nav', 'section', 'table'];
        type SnapshotCandidate = HTMLElement;
        // Priority has only three values; buckets preserve DOM order without sorting every visible node.
        const buckets: [SnapshotCandidate[], SnapshotCandidate[], SnapshotCandidate[]] = [[], [], []];
        for (const element of allElements()) {
          if (!visible(element)) continue;
          const tag = tagOf(element);
          const role = element.getAttribute('role') ?? undefined;
          const name = element.getAttribute('aria-label') ?? element.getAttribute('name') ?? undefined;
          const href = tag === 'a' ? (element as HTMLAnchorElement).href : undefined;
          const priority: 0 | 1 | 2 = actionableTags.includes(tag) || (tag === 'a' && Boolean(href)) ||
            (role !== undefined && actionableRoles.includes(role.toLowerCase()))
            ? 0
            : (role || name || semanticTags.includes(tag)) ? 1 : 2;
          buckets[priority].push(element);
        }
        const ordered: SnapshotCandidate[] = [];
        for (const bucket of buckets) {
          for (const candidate of bucket) {
            if (ordered.length >= maxNodes) break;
            ordered.push(candidate);
          }
          if (ordered.length >= maxNodes) break;
        }
        return succeed(ordered.map((element) => {
          const tag = tagOf(element);
          const role = element.getAttribute('role') ?? undefined;
          const name = element.getAttribute('aria-label') ?? element.getAttribute('name') ?? undefined;
          const href = tag === 'a' ? (element as HTMLAnchorElement).href : undefined;
          const rawText = element.innerText?.replace(/\s+/g, ' ').trim();
          return {
            ref: refFor(element),
            tag,
            ...(role ? { role } : {}),
            ...(name ? { name: name.slice(0, 300) } : {}),
            ...(rawText ? { text: rawText.slice(0, 500) } : {}),
            ...((tag === 'button' || tag === 'input') ? { disabled: Boolean((element as HTMLButtonElement).disabled) } : {}),
            ...(href ? { href: href.slice(0, 1_000) } : {}),
          } satisfies SnapshotNode;
        }));
      }
      if (action.kind === 'element_rect') {
        const element = findByRef(action.ref);
        requireInteractable(element);
        scrollIntoTopViewport(element);
        const rect = topViewportRect(element);
        const intersectsViewport = rect.left + rect.width > 0 && rect.top + rect.height > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
        if (!intersectsViewport || rect.width <= 0 || rect.height <= 0) {
          return fail('element_outside_viewport', 'The target element remains outside the top-level viewport.');
        }
        return succeed(rect);
      }
      if (action.kind === 'viewport') {
        return succeed({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 });
      }
      if (action.kind === 'click') {
        const element = findByRef(action.ref);
        requireInteractable(element);
        element.focus();
        element.click();
        return succeed({ changed: true });
      }
      if (action.kind === 'hover') {
        const element = findByRef(action.ref);
        requireInteractable(element);
        const rect = element.getBoundingClientRect();
        const view = elementWindow(element);
        const eventInit = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        element.dispatchEvent(new view.MouseEvent('mouseover', eventInit));
        element.dispatchEvent(new view.MouseEvent('mousemove', eventInit));
        return succeed({ changed: true });
      }
      if (action.kind === 'fill' || action.kind === 'type') {
        const element = findByRef(action.ref);
        requireInteractable(element);
        const tag = tagOf(element);
        const input = tag === 'input' ? element as HTMLInputElement : undefined;
        const textarea = tag === 'textarea' ? element as HTMLTextAreaElement : undefined;
        if (!input && !textarea && !element.isContentEditable) {
          return fail('element_not_editable', 'The target element does not accept text.');
        }
        if ((input || textarea)?.readOnly) return fail('element_readonly', 'The target text control is read-only.');
        if (input && ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(input.type)) {
          return fail('element_not_editable', 'The target input type does not accept text.');
        }
        element.focus();
        const data = action.kind === 'fill' ? action.value : action.text;
        let usedNativeInsertion = false;
        if (input || textarea) {
          const textControl = (input ?? textarea) as HTMLInputElement | HTMLTextAreaElement;
          const nextValue = action.kind === 'fill' ? action.value : `${textControl.value}${action.text}`;
          setTextValue(textControl, nextValue);
        } else {
          usedNativeInsertion = insertContentEditableText(element, data, action.kind === 'fill');
          if (!usedNativeInsertion) element.textContent = action.kind === 'fill' ? action.value : `${element.textContent ?? ''}${action.text}`;
        }
        const view = elementWindow(element);
        if (!usedNativeInsertion) element.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
        element.dispatchEvent(new view.Event('change', { bubbles: true }));
        return succeed({ changed: true });
      }
      if (action.kind === 'select') {
        const element = findByRef(action.ref);
        requireInteractable(element);
        if (tagOf(element) !== 'select') return fail('invalid_target', 'The target element is not a select control.');
        const select = element as HTMLSelectElement;
        const option = Array.from(select.options).find((candidate) => candidate.value === action.value && !candidate.disabled);
        if (!option) return fail('invalid_select_option', 'The requested select option is unavailable or disabled.');
        select.value = option.value;
        const view = elementWindow(element);
        select.dispatchEvent(new view.Event('input', { bubbles: true }));
        select.dispatchEvent(new view.Event('change', { bubbles: true }));
        return succeed({ changed: true });
      }
      if (action.kind === 'press') {
        const element = action.ref ? findByRef(action.ref) : deepActiveElement();
        if (action.ref || (element !== element.ownerDocument.body && element !== element.ownerDocument.documentElement)) requireInteractable(element);
        element.focus();
        const view = elementWindow(element);
        const init = { key: action.key, code: action.code ?? action.key, bubbles: true, cancelable: true };
        const allowed = element.dispatchEvent(new view.KeyboardEvent('keydown', init));
        if (allowed) {
          if (action.key === 'Enter') {
            const form = element.closest('form') as HTMLFormElement | null;
            if (form) form.requestSubmit();
            else if (tagOf(element) === 'button' || element.getAttribute('role') === 'button') element.click();
          } else if (action.key === ' ' || action.key === 'Spacebar') {
            if (tagOf(element) === 'button' || element.getAttribute('role') === 'button') element.click();
          } else if (action.key === 'Tab') {
            focusNext(element);
          } else if ((action.key === 'Backspace' || action.key === 'Delete') && ['input', 'textarea'].includes(tagOf(element))) {
            const textControl = element as HTMLInputElement | HTMLTextAreaElement;
            const start = textControl.selectionStart ?? textControl.value.length;
            const end = textControl.selectionEnd ?? start;
            const from = action.key === 'Backspace' && start === end ? Math.max(0, start - 1) : start;
            const to = action.key === 'Delete' && start === end ? Math.min(textControl.value.length, end + 1) : end;
            setTextValue(textControl, `${textControl.value.slice(0, from)}${textControl.value.slice(to)}`);
            textControl.setSelectionRange(from, from);
            textControl.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          }
        }
        element.dispatchEvent(new view.KeyboardEvent('keyup', init));
        return succeed({ changed: true });
      }
      if (action.kind === 'scroll') {
        const target = action.ref ? findByRef(action.ref) : document.scrollingElement ?? document.documentElement;
        if (action.ref) requireInteractable(target as HTMLElement);
        if (action.ref && action.x === undefined && action.y === undefined) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        else if (action.ref) target.scrollBy({ left: action.x ?? 0, top: action.y ?? 0, behavior: 'auto' });
        else window.scrollBy({ left: action.x ?? 0, top: action.y ?? 0, behavior: 'auto' });
        return succeed({ changed: true });
      }
      if (action.kind === 'upload') {
        const input = findByRef(action.ref);
        requireInteractable(input);
        if (tagOf(input) !== 'input' || (input as HTMLInputElement).type !== 'file') {
          return fail('invalid_upload_target', 'The target element is not a file input.');
        }
        const view = elementWindow(input);
        const files = action.files.map((file) => {
          const binary = view.atob(file.contentBase64);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          return new view.File([bytes], file.filename, { type: file.mimeType });
        });
        const transfer = new view.DataTransfer();
        for (const file of files) transfer.items.add(file);
        (input as HTMLInputElement).files = transfer.files;
        input.dispatchEvent(new view.Event('input', { bubbles: true }));
        input.dispatchEvent(new view.Event('change', { bubbles: true }));
        return succeed({ uploaded: true, count: files.length });
      }
      return fail('unsupported_action', 'The requested browser automation action is unsupported.');
    } catch (error) {
      if (error && typeof error === 'object' && 'overseerAutomationFailure' in error && error.overseerAutomationFailure === true) {
        const failure = error as LocalFailure;
        return { ok: false, error: { code: failure.code, message: failure.message, ...(failure.fallback ? { fallback: failure.fallback } : {}) } };
      }
      return { ok: false, error: { code: 'automation_failed', message: 'Browser automation failed in the target tab.' } };
    } finally {
      signalDialogCleanup();
    }
  };
  if (!MUTATION_EVIDENCE_KINDS[action.kind]) return execute();
  let mutations = 0;
  const observer = new MutationObserver((records) => {
    mutations += records.length;
    if (mutations > MUTATION_EVIDENCE_CAP) observer.disconnect();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    const result = execute();
    // Flush one macrotask so microtask-batched framework reactions are counted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (result.ok && result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
      return { ok: true, value: { ...(result.value as Record<string, unknown>), dom_mutations: Math.min(mutations, MUTATION_EVIDENCE_CAP) } };
    }
    return result;
  } finally {
    observer.disconnect();
  }
}

export function installDialogGuards(token: string): boolean {
  type DialogName = 'alert' | 'confirm' | 'prompt';
  type DialogState = {
    dialogs: CapturedDialog[];
    cleanup: () => void;
  };
  let attempted = 0;
  let installed = 0;
  const visit = (target: Window): void => {
    try {
      const host = target as Window & Record<string, unknown>;
      if (host[token] === undefined) {
        attempted += 1;
        const dialogs: CapturedDialog[] = [];
        const append = (dialog: CapturedDialog): void => {
          if (dialogs.length < 16) dialogs.push(dialog);
        };
        const alertGuard = (message?: unknown): void => append({
          type: 'alert',
          message: String(message ?? '').slice(0, 1_000),
          response: true,
        });
        const confirmGuard = (message?: string): boolean => {
          append({ type: 'confirm', message: String(message ?? '').slice(0, 1_000), response: false });
          return false;
        };
        const promptGuard = (message?: string, defaultValue?: string): string | null => {
          append({
            type: 'prompt',
            message: String(message ?? '').slice(0, 1_000),
            defaultValue: String(defaultValue ?? '').slice(0, 1_000),
            response: null,
          });
          return null;
        };
        const guards: Record<DialogName, Function> = { alert: alertGuard, confirm: confirmGuard, prompt: promptGuard };
        const descriptors: Record<DialogName, PropertyDescriptor | undefined> = {
          alert: Object.getOwnPropertyDescriptor(target, 'alert'),
          confirm: Object.getOwnPropertyDescriptor(target, 'confirm'),
          prompt: Object.getOwnPropertyDescriptor(target, 'prompt'),
        };
        const state = {} as DialogState;
        let listening = false;
        const restoreGlobals = (): void => {
          for (const name of ['alert', 'confirm', 'prompt'] as const) {
            try {
              const current = Object.getOwnPropertyDescriptor(target, name);
              if (current?.value !== guards[name]) continue;
              const original = descriptors[name];
              if (original) Object.defineProperty(target, name, original);
              else delete (target as unknown as Record<string, unknown>)[name];
            } catch {
              // Continue restoring the remaining globals.
            }
          }
        };
        const release = (): void => restoreGlobals();
        const cleanup = (): void => {
          restoreGlobals();
          if (listening) target.document.removeEventListener(token, release);
          try {
            if (host[token] === state) delete host[token];
          } catch {
            // A hostile page may prevent token cleanup.
          }
        };
        Object.assign(state, { dialogs, cleanup });
        try {
          Object.defineProperty(host, token, { value: state, configurable: true });
          target.document.addEventListener(token, release, { once: true });
          listening = true;
          for (const name of ['alert', 'confirm', 'prompt'] as const) {
            Object.defineProperty(target, name, {
              value: guards[name],
              configurable: true,
              enumerable: descriptors[name]?.enumerable ?? true,
              writable: true,
            });
          }
          installed += 1;
        } catch {
          cleanup();
        }
      }
      for (let index = 0; index < target.frames.length; index += 1) visit(target.frames[index] as Window);
    } catch {
      // Cross-origin child windows cannot be guarded without debugger privileges.
    }
  };
  visit(window);
  return attempted > 0 && installed === attempted;
}

async function collectDialogGuards(token: string): Promise<CapturedDialog[]> {
  type DialogState = { dialogs: CapturedDialog[]; cleanup: () => void };
  const dialogs: CapturedDialog[] = [];
  const visit = (target: Window): void => {
    try {
      const host = target as Window & Record<string, unknown>;
      const state = host[token] as DialogState | undefined;
      if (state) {
        for (const dialog of state.dialogs) {
          if (dialogs.length < 16) dialogs.push(dialog);
        }
        state.cleanup();
      }
      for (let index = 0; index < target.frames.length; index += 1) visit(target.frames[index] as Window);
    } catch {
      // Cross-origin child windows are intentionally opaque.
    }
  };
  visit(window);
  return dialogs;
}
