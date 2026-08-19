export const WAIT_MAX_TIMEOUT_MS = 45_000;
export const WAIT_DEFAULT_TIMEOUT_MS = 15_000;
export const WAIT_MIN_STABLE_MS = 100;
export const WAIT_MAX_STABLE_MS = 30_000;
const WAIT_MAX_TEXT_CHARS = 2_000;
const WAIT_MAX_SELECTOR_CHARS = 1_000;
const WAIT_MAX_URL_CHARS = 2_048;

export type WaitSelectorState = 'visible' | 'hidden' | 'enabled';

export type WaitCondition =
  | { type: 'text'; text: string; absent: boolean }
  | { type: 'selector'; selector: string; state: WaitSelectorState }
  | { type: 'dom_stable'; quietMs: number };

export type WaitTarget =
  | { kind: 'page'; condition: WaitCondition; timeoutMs: number }
  | { kind: 'url'; urlContains: string; timeoutMs: number }
  | { kind: 'ready'; timeoutMs: number };

export class WaitError extends Error {
  constructor(readonly code: string, message: string, readonly fallback?: string) {
    super(message);
    this.name = 'WaitError';
  }
}

function invalid(message: string): never {
  throw new WaitError('invalid_params', message);
}

function readBoundedString(params: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    invalid(`${key} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function readTimeoutMs(params: Record<string, unknown>): number {
  const value = params.timeout_ms;
  if (value === undefined) return WAIT_DEFAULT_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > WAIT_MAX_TIMEOUT_MS) {
    invalid(`timeout_ms must be an integer between 1 and ${WAIT_MAX_TIMEOUT_MS}.`);
  }
  return value;
}

/** Parse `wait.for` params into exactly one bounded, event-driven condition. */
export function parseWaitTarget(params: Record<string, unknown>): WaitTarget {
  const timeoutMs = readTimeoutMs(params);
  const ready = params.ready === true;
  const urlContains = readBoundedString(params, 'url_contains', WAIT_MAX_URL_CHARS);
  const text = readBoundedString(params, 'text', WAIT_MAX_TEXT_CHARS);
  const selector = readBoundedString(params, 'selector', WAIT_MAX_SELECTOR_CHARS);
  const stableMs = params.dom_stable_ms;
  if (params.absent !== undefined && typeof params.absent !== 'boolean') invalid('absent must be boolean when supplied.');
  if (params.state !== undefined && params.state !== 'visible' && params.state !== 'hidden' && params.state !== 'enabled') {
    invalid("state must be 'visible', 'hidden', or 'enabled' when supplied.");
  }
  if (stableMs !== undefined && (typeof stableMs !== 'number' || !Number.isInteger(stableMs) || stableMs < WAIT_MIN_STABLE_MS || stableMs > WAIT_MAX_STABLE_MS)) {
    invalid(`dom_stable_ms must be an integer between ${WAIT_MIN_STABLE_MS} and ${WAIT_MAX_STABLE_MS}.`);
  }
  const conditionCount = [ready, urlContains !== undefined, text !== undefined, selector !== undefined, stableMs !== undefined]
    .filter(Boolean).length;
  if (conditionCount !== 1) invalid('wait.for requires exactly one condition: ready, url_contains, text, selector, or dom_stable_ms.');
  if (params.absent === true && text === undefined) invalid('absent applies only to the text condition.');
  if (params.state !== undefined && selector === undefined) invalid('state applies only to the selector condition.');
  if (ready) return { kind: 'ready', timeoutMs };
  if (urlContains !== undefined) return { kind: 'url', urlContains, timeoutMs };
  if (text !== undefined) return { kind: 'page', condition: { type: 'text', text, absent: params.absent === true }, timeoutMs };
  if (selector !== undefined) {
    const state = (params.state as WaitSelectorState | undefined) ?? 'visible';
    return { kind: 'page', condition: { type: 'selector', selector, state }, timeoutMs };
  }
  return { kind: 'page', condition: { type: 'dom_stable', quietMs: stableMs as number }, timeoutMs };
}
