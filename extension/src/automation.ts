import { MAX_UPLOAD_BYTES } from './protocol';

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
  | { kind: 'upload'; ref: string; filename: string; mimeType: string; contentBase64: string };

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
  if (action.kind === 'upload') {
    if (Math.floor(action.contentBase64.length * 3 / 4) > MAX_UPLOAD_BYTES) {
      throw new AutomationError('upload_too_large', 'Upload exceeds the 8 MiB extension limit.');
    }
    if (!isBoundedUpload(action)) {
      throw new AutomationError('invalid_upload', 'Upload metadata or content is invalid.');
    }
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: isolatedAutomation,
    args: [action],
  });
  return result?.result;
}

export async function runPageEvaluation(tabId: number, source: string): Promise<unknown> {
  if (source.length === 0 || source.length > 32_000) {
    throw new AutomationError('invalid_evaluate', 'Evaluate source must be between 1 and 32000 characters.');
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: pageWorldEvaluation,
    args: [source],
  });
  return result?.result;
}

export function stableRefForPath(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `osr-${(hash >>> 0).toString(36)}`;
}

export function isBoundedUpload(action: Extract<AutomationAction, { kind: 'upload' }>): boolean {
  const filenameBytes = new TextEncoder().encode(action.filename).byteLength;
  if (filenameBytes < 1 || filenameBytes > 255) return false;
  if (action.filename === '.' || action.filename === '..') return false;
  if (/[/\\\u0000-\u001f\u007f]/.test(action.filename)) return false;
  if (action.mimeType.length < 1 || action.mimeType.length > 128) return false;
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(action.mimeType)) return false;
  return Math.floor(action.contentBase64.length * 3 / 4) <= MAX_UPLOAD_BYTES;
}

export class AutomationError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'AutomationError';
  }
}
function isolatedAutomation(action: AutomationAction): SnapshotNode[] | RectResult | { width: number; height: number; devicePixelRatio: number } | { changed: boolean } | { uploaded: boolean } | null {
  const stableRef = (path: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `osr-${(hash >>> 0).toString(36)}`;
  };
  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const focusNext = (current: HTMLElement): void => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]',
    )).filter((candidate) => (
      visible(candidate) &&
      candidate.tabIndex >= 0 &&
      !candidate.hasAttribute('disabled') &&
      candidate.getAttribute('aria-disabled') !== 'true' &&
      candidate.closest('[inert]') === null
    ));
    if (candidates.length === 0) return;
    const currentIndex = candidates.indexOf(current);
    candidates[(currentIndex + 1) % candidates.length]?.focus();
  };
  const pathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.parentElement) {
      let index = 0;
      let sibling = current.previousElementSibling;
      while (sibling) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.push(`${current.tagName.toLowerCase()}:${index}`);
      current = current.parentElement;
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
  const allVisible = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    for (const element of document.querySelectorAll('*')) if (visible(element)) nodes.push(element);
    return nodes;
  };
  const findByRef = (ref: string): HTMLElement => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-overseer-ref]')) {
      if (element.getAttribute('data-overseer-ref') === ref) return element;
    }
    for (const element of allVisible()) if (refFor(element) === ref) return element;
    throw new Error(`Stable ref not found: ${ref}`);
  };
  const setTextValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('Target value setter is unavailable.');
    setter.call(element, value);
  };
  if (action.kind === 'snapshot' || action.kind === 'observe') {
    const maxNodes = Math.min(Math.max(action.maxNodes ?? 200, 1), 500);
    const actionableTags = ['button', 'input', 'select', 'textarea', 'summary'];
    const actionableRoles = ['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox'];
    const semanticTags = ['address', 'article', 'aside', 'details', 'figcaption', 'figure', 'footer', 'form', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'main', 'nav', 'section', 'table'];
    const snapshotPriority = (element: HTMLElement): 0 | 1 | 2 => {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role')?.toLowerCase();
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      const name = element.getAttribute('aria-label') ?? element.getAttribute('name') ?? undefined;
      if (actionableTags.includes(tag) || (tag === 'a' && Boolean(href)) || (role !== undefined && actionableRoles.includes(role))) return 0;
      if (role || name || semanticTags.includes(tag)) return 1;
      return 2;
    };
    const ordered = allVisible()
      .map((element, index) => ({ element, index, priority: snapshotPriority(element) }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .slice(0, maxNodes)
      .map(({ element }) => element);
    return ordered.map((element) => {
      const rawText = element.innerText?.replace(/\s+/g, ' ').trim();
      const role = element.getAttribute('role') ?? undefined;
      const name = element.getAttribute('aria-label') ?? element.getAttribute('name') ?? undefined;
      const href = element instanceof HTMLAnchorElement ? element.href : undefined;
      return {
        ref: refFor(element),
        tag: element.tagName.toLowerCase(),
        ...(role ? { role } : {}),
        ...(name ? { name: name.slice(0, 300) } : {}),
        ...(rawText ? { text: rawText.slice(0, 500) } : {}),
        ...(element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? { disabled: element.disabled } : {}),
        ...(href ? { href: href.slice(0, 1_000) } : {}),
      } satisfies SnapshotNode;
    });
  }
  if (action.kind === 'element_rect') {
    const element = findByRef(action.ref);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = element.getBoundingClientRect();
    const intersectsViewport = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    if (!intersectsViewport || rect.width <= 0 || rect.height <= 0) throw new Error('Target element is outside the viewport.');
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  if (action.kind === 'viewport') {
    return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 };
  }
  if (action.kind === 'click') {
    const element = findByRef(action.ref);
    element.focus();
    element.click();
    return { changed: true };
  }
  if (action.kind === 'hover') {
    const element = findByRef(action.ref);
    const rect = element.getBoundingClientRect();
    const eventInit = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    element.dispatchEvent(new MouseEvent('mouseover', eventInit));
    element.dispatchEvent(new MouseEvent('mousemove', eventInit));
    return { changed: true };
  }
  if (action.kind === 'fill' || action.kind === 'type') {
    const element = findByRef(action.ref);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable))) throw new Error('Target does not accept text.');
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const nextValue = action.kind === 'fill' ? action.value : `${element.value}${action.text}`;
      setTextValue(element, nextValue);
    } else if (action.kind === 'fill') {
      element.textContent = action.value;
    } else {
      element.textContent = `${element.textContent ?? ''}${action.text}`;
    }
    const data = action.kind === 'fill' ? action.value : action.text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true };
  }
  if (action.kind === 'select') {
    const element = findByRef(action.ref);
    if (!(element instanceof HTMLSelectElement)) throw new Error('Target is not a select element.');
    element.value = action.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { changed: true };
  }
  if (action.kind === 'press') {
    const element = action.ref ? findByRef(action.ref) : document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    element.focus();
    const init = { key: action.key, code: action.code ?? action.key, bubbles: true, cancelable: true };
    const allowed = element.dispatchEvent(new KeyboardEvent('keydown', init));
    if (allowed) {
      if (action.key === 'Enter') {
        const form = element.closest('form');
        if (form instanceof HTMLFormElement) form.requestSubmit();
        else if (element instanceof HTMLButtonElement || element.getAttribute('role') === 'button') element.click();
      } else if (action.key === ' ' || action.key === 'Spacebar') {
        if (element instanceof HTMLButtonElement || element.getAttribute('role') === 'button') element.click();
      } else if (action.key === 'Tab') {
        focusNext(element);
      } else if ((action.key === 'Backspace' || action.key === 'Delete') && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? start;
        const from = action.key === 'Backspace' && start === end ? Math.max(0, start - 1) : start;
        const to = action.key === 'Delete' && start === end ? Math.min(element.value.length, end + 1) : end;
        setTextValue(element, `${element.value.slice(0, from)}${element.value.slice(to)}`);
        element.setSelectionRange(from, from);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
    element.dispatchEvent(new KeyboardEvent('keyup', init));
    return { changed: true };
  }
  if (action.kind === 'scroll') {
    const target = action.ref ? findByRef(action.ref) : document.scrollingElement ?? document.documentElement;
    if (action.ref && action.x === undefined && action.y === undefined) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    else if (action.ref) target.scrollBy({ left: action.x ?? 0, top: action.y ?? 0, behavior: 'auto' });
    else window.scrollBy({ left: action.x ?? 0, top: action.y ?? 0, behavior: 'auto' });
    return { changed: true };
  }
  if (action.kind === 'upload') {
    const input = findByRef(action.ref);
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') throw new Error('Target is not a file input.');
    const binary = atob(action.contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], action.filename, { type: action.mimeType }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { uploaded: true };
  }
  return null;
}

function pageWorldEvaluation(source: string): unknown {
  // This callback runs only in the requested tab's MAIN world through scripting.executeScript.
  const evaluateSource = (globalThis as { Function: Function }).Function;
  return evaluateSource(`"use strict"; return (${source});`)();
}
