import { describe, expect, it, vi } from 'vitest';
import { mockMultiSessionBrowser } from './helpers/multi-session-browser';

async function setup() {
  const fixture = mockMultiSessionBrowser();
  vi.resetModules();
  const background = await import('../entrypoints/background');
  let sequence = 0;
  const call = (key: string, command: string, params: Record<string, unknown> = {}) => background.dispatch({ version: 1, kind: 'request', request_id: `request-${++sequence}`, session_key: key, command, params }, { cancelled: false });
  const start = async (key: string) => {
    const session = await call(key, 'sessions.start') as { selectedTabId: number; agentWindowId: number };
    fixture.tabs.get(session.selectedTabId)!.url = `https://${key}.test/`;
    return session;
  };
  return { ...fixture, background, call, start };
}

describe('request-local multi-agent dispatch', () => {
  it('echoes scope in a capability probe without scanning any windows or tabs', async () => {
    const { call, stub } = await setup();
    expect(await call('a', 'health.status', { capabilities_only: true })).toEqual({ multi_session: true, session_key: 'a', extension_version: '0.3.0' });
    expect(stub.tabs.query).not.toHaveBeenCalled();
    expect(stub.windows.get).not.toHaveBeenCalled();
  });

  it('routes eight simultaneous scopes and their batches without using another selected tab', async () => {
    const { call, start } = await setup();
    const keys = Array.from({ length: 8 }, (_, index) => `agent-${index}`);
    const sessions = await Promise.all(keys.map(start));
    expect(new Set(sessions.map((session) => session.agentWindowId)).size).toBe(8);
    const batches = await Promise.all(keys.map((key) => call(key, 'batch', { actions: [{ command: 'tabs.list' }] }))) as Array<{ results: Array<{ result: Array<{ id: number }> }> }>;
    batches.forEach((batch, index) => expect(batch.results[0]?.result.map((tab) => tab.id)).toEqual([sessions[index]?.selectedTabId]));
    await expect(call('missing', 'snapshot')).rejects.toMatchObject({ code: 'session_required' });
    await expect(call(keys[0]!, 'snapshot', { tab_id: sessions[1]!.selectedTabId })).rejects.toMatchObject({ code: 'tab_owned_by_another_session' });
    await expect(call(keys[0]!, 'batch', { actions: [{ command: 'tabs.list', session_key: keys[1] }] })).rejects.toBeDefined();
  });

  it('allows mutations in different sessions to execute concurrently, and stopping A does not cancel B', async () => {
    const { call, start, stub } = await setup();
    const [a, b] = await Promise.all([start('a'), start('b')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered: number[] = [];
    stub.scripting.executeScript.mockImplementation(async (details) => {
      entered.push(details.target.tabId);
      await gate;
      return [{ result: { ok: true, value: 'filled' } }];
    });
    const fillA = call('a', 'fill', { ref: 'osr-1', value: 'A' });
    const fillB = call('b', 'fill', { ref: 'osr-1', value: 'B' });
    await vi.waitFor(() => expect(new Set(entered)).toEqual(new Set([a.selectedTabId, b.selectedTabId])));
    await call('a', 'sessions.stop');
    release();
    await expect(fillB).resolves.toBe('filled');
    await fillA;
    expect(stub.windows.remove).not.toHaveBeenCalledWith(b.agentWindowId);
    expect(await call('b', 'tabs.list')).toMatchObject([{ id: b.selectedTabId }]);
  });

  it('rejects cross-scope cancellation and stops only requests belonging to the stopped session', async () => {
    const { call, start, stub, background } = await setup();
    await Promise.all([start('a'), start('b')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    stub.scripting.executeScript.mockImplementation(async () => { await gate; return [{ result: { ok: true, value: 'filled' } }]; });
    const request = (key: string) => ({ version: 1 as const, kind: 'request' as const, request_id: `pending-${key}`, session_key: key, command: 'fill', params: { ref: 'osr-1', value: key } });
    let bFinished = false;
    const pendingA = background.handleRequest(request('a'));
    const pendingB = background.handleRequest(request('b')).then(() => { bFinished = true; });
    await vi.waitFor(() => expect(stub.scripting.executeScript).toHaveBeenCalledTimes(2));
    expect(await call('b', 'cancel', { request_id: 'pending-a' })).toEqual({ cancelled: false, request_id: 'pending-a' });
    await call('a', 'sessions.stop');
    await pendingA;
    expect(bFinished).toBe(false);
    release();
    await pendingB;
    expect(bFinished).toBe(true);
  });

  it('does not reset another agent’s observe baseline when a session stops', async () => {
    const { call, start, stub } = await setup();
    await Promise.all([start('a'), start('b')]);
    stub.scripting.executeScript.mockResolvedValue([{ result: { ok: true, value: [{ ref: 'osr-1', tag: 'button', name: 'Submit' }] } }]);
    expect(await call('b', 'observe', { changes: true })).toMatchObject({ baseline: true });
    await call('a', 'sessions.stop');
    expect(await call('b', 'observe', { changes: true })).toMatchObject({ baseline: false, unchanged: 1 });
  });

  it('isolates identical upload transaction IDs and drops only the released tab’s chunks', async () => {
    const { background } = await setup();
    const assembler = new background.UploadAssembler();
    const chunk = { upload_id: 'same-id', ref: 'osr-1', index: 0, total: 2, filename: 'test.txt', mime_type: 'text/plain', chunk: 'YQ==' };
    assembler.addChunk(chunk, 11, 'osr-1', 'a');
    assembler.addChunk(chunk, 22, 'osr-1', 'b');
    expect(assembler.size).toBe(2);
    assembler.dropTab(11);
    expect(assembler.size).toBe(1);
    expect(assembler.addChunk({ ...chunk, index: 1 }, 22, 'osr-1', 'b')).toMatchObject({ complete: true, files: [{ contentBase64: 'YWE=' }] });
    expect(assembler.size).toBe(0);
  });

  it('keeps session takeover local and rejects cross-agent meeting capture controls', async () => {
    const { call, start } = await setup();
    await Promise.all([start('a'), start('b')]);
    await call('a', 'takeover.prompt');
    await expect(call('a', 'snapshot')).rejects.toMatchObject({ code: 'human_takeover_active' });
    await expect(call('b', 'snapshot')).resolves.toEqual([]);
    await call('b', 'takeover.resume');
    await expect(call('a', 'snapshot')).rejects.toMatchObject({ code: 'human_takeover_active' });
    await call('a', 'takeover.resume');
    await expect(call('a', 'snapshot')).resolves.toEqual([]);
    await expect(call('a', 'capture.stop')).rejects.toMatchObject({ code: 'operator_scope_required' });
  });
});
