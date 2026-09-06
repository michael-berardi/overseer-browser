import { describe, expect, it } from 'vitest';
import { parseNativeRequest } from '../src/protocol';

const request = { version: 1, kind: 'request', request_id: 'test', command: 'tabs.list' };
describe('native session envelope', () => {
  it('preserves an explicit scope and retains legacy omission', () => {
    expect(parseNativeRequest({ ...request, session_key: 'agent-a' })).toMatchObject({ ok: true, request: { session_key: 'agent-a' } });
    const legacy = parseNativeRequest(request);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.request).not.toHaveProperty('session_key');
  });
  it.each([null, 1, '', '../escape', 'a b', 'a\n', 'x'.repeat(129)])('rejects malformed scope %j', (session_key) => {
    expect(parseNativeRequest({ ...request, session_key })).toMatchObject({ ok: false, error: { code: 'invalid_session_key' } });
  });
});
