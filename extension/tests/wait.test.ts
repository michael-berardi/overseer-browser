import { describe, expect, it } from 'vitest';
import { WAIT_DEFAULT_TIMEOUT_MS, WaitError, parseWaitTarget } from '../src/wait';

describe('wait.for condition parsing', () => {
  it('parses each supported condition with the default timeout', () => {
    expect(parseWaitTarget({ ready: true })).toEqual({ kind: 'ready', timeoutMs: WAIT_DEFAULT_TIMEOUT_MS });
    expect(parseWaitTarget({ url_contains: 'example.test' })).toEqual({ kind: 'url', urlContains: 'example.test', timeoutMs: WAIT_DEFAULT_TIMEOUT_MS });
    expect(parseWaitTarget({ text: 'Done' })).toEqual({ kind: 'page', condition: { type: 'text', text: 'Done', absent: false }, timeoutMs: WAIT_DEFAULT_TIMEOUT_MS });
    expect(parseWaitTarget({ text: 'Loading', absent: true, timeout_ms: 5_000 })).toEqual({
      kind: 'page',
      condition: { type: 'text', text: 'Loading', absent: true },
      timeoutMs: 5_000,
    });
    expect(parseWaitTarget({ selector: '.result' })).toEqual({
      kind: 'page',
      condition: { type: 'selector', selector: '.result', state: 'visible' },
      timeoutMs: WAIT_DEFAULT_TIMEOUT_MS,
    });
    expect(parseWaitTarget({ selector: '.result', state: 'enabled' })).toEqual({
      kind: 'page',
      condition: { type: 'selector', selector: '.result', state: 'enabled' },
      timeoutMs: WAIT_DEFAULT_TIMEOUT_MS,
    });
    expect(parseWaitTarget({ dom_stable_ms: 500 })).toEqual({
      kind: 'page',
      condition: { type: 'dom_stable', quietMs: 500 },
      timeoutMs: WAIT_DEFAULT_TIMEOUT_MS,
    });
  });

  it('rejects zero or multiple conditions', () => {
    for (const params of [
      {},
      { timeout_ms: 1_000 },
      { ready: true, text: 'x' },
      { url_contains: 'a', selector: '.b' },
      { text: 'a', dom_stable_ms: 500 },
    ]) {
      expect(() => parseWaitTarget(params)).toThrowError(expect.objectContaining({ code: 'invalid_params' }));
    }
  });

  it('rejects modifiers detached from their condition', () => {
    expect(() => parseWaitTarget({ ready: true, absent: true })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ url_contains: 'a', state: 'hidden' })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ text: 'a', absent: 'yes' })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ selector: '.a', state: 'focused' })).toThrowError(WaitError);
  });

  it('bounds timeouts, text, selectors, and stability windows', () => {
    expect(() => parseWaitTarget({ ready: true, timeout_ms: 0 })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ ready: true, timeout_ms: 45_001 })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ ready: true, timeout_ms: 1.5 })).toThrowError(WaitError);
    expect(parseWaitTarget({ ready: true, timeout_ms: 45_000 }).timeoutMs).toBe(45_000);
    expect(() => parseWaitTarget({ text: '' })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ text: 'x'.repeat(2_001) })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ selector: 'x'.repeat(1_001) })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ dom_stable_ms: 99 })).toThrowError(WaitError);
    expect(() => parseWaitTarget({ dom_stable_ms: 30_001 })).toThrowError(WaitError);
  });
});
