import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry, MAX_BROWSER_SESSIONS } from '../src/session_registry';
import { mockMultiSessionBrowser } from './helpers/multi-session-browser';

let fixture: ReturnType<typeof mockMultiSessionBrowser>;
beforeEach(() => { fixture = mockMultiSessionBrowser(); });

describe('independent agent sessions', () => {
  it('starts concurrent agents in separate windows, with idempotent same-scope start', async () => {
    const registry = new SessionRegistry();
    const [a, b, again] = await Promise.all([registry.start('agent-a', 'Alpha'), registry.start('agent-b', 'Beta'), registry.start('agent-a', 'Alpha')]);
    expect(a.agentWindowId).not.toBe(b.agentWindowId);
    expect(a.sessionId).toBe(again.sessionId);
    expect(again.started).toBe(false);
    expect(fixture.stub.windows.create).toHaveBeenCalledTimes(2);
    expect((await registry.list()).map((session) => session.sessionKey)).toEqual(['agent-a', 'agent-b']);
  });

  it('keeps implicit selected tabs, explicit ownership, storage, and cleanup separate', async () => {
    const release = vi.fn(async () => undefined);
    const registry = new SessionRegistry(release);
    const [a, b] = await Promise.all([registry.start('a'), registry.start('b')]);
    const am = await registry.get('a');
    const bm = await registry.get('b');
    const newA = await am.createTab('https://a.test/');
    const newB = await bm.createTab('https://b.test/');
    await am.selectTab(a.selectedTabId!);
    expect(await bm.getSelectedTabId()).toBe(newB.id);
    await expect(am.selectTab(newB.id!)).rejects.toMatchObject({ code: 'tab_owned_by_another_session' });
    await expect(am.closeTab(newB.id!)).rejects.toMatchObject({ code: 'tab_owned_by_another_session' });
    await expect(registry.borrow('a', newB.id!)).rejects.toMatchObject({ code: 'tab_owned_by_another_session' });
    await registry.borrow('a', 1);
    await registry.stop('a');
    expect(fixture.tabs.has(1)).toBe(true);
    expect(fixture.windows.has(b.agentWindowId)).toBe(true);
    expect(await bm.getSelectedTabId()).toBe(newB.id);
    expect(release).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(newA.id);
    expect(release).not.toHaveBeenCalledWith(newB.id);
    expect(fixture.storage['overseer.session.v2.a']).toBeUndefined();
    expect(fixture.storage['overseer.session.v2.b']).toBeDefined();
  });

  it('atomically grants a user tab to only one of two simultaneous borrowers', async () => {
    const registry = new SessionRegistry();
    await Promise.all([registry.start('a'), registry.start('b')]);
    const claims = await Promise.allSettled([registry.borrow('a', 1), registry.borrow('b', 1)]);
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
    await (await registry.get('a')).returnTab(1);
    expect(await registry.borrow('b', 1)).toMatchObject({ id: 1 });
  });

  it('requires an explicit popup recipient when more than one session is active', async () => {
    const registry = new SessionRegistry();
    await registry.start('a');
    expect((await registry.popupTarget()).sessionKey).toBe('a');
    await registry.start('b');
    await expect(registry.popupTarget()).rejects.toMatchObject({ code: 'session_selection_required' });
    expect((await registry.popupTarget('b')).sessionKey).toBe('b');
  });

  it('restores every scope on worker restart and never falls back to another agent', async () => {
    const registry = new SessionRegistry();
    const legacy = await registry.start(undefined, 'Existing window');
    const a = await registry.start('a');
    const b = await registry.start('b');
    const reloaded = new SessionRegistry();
    expect((await reloaded.list()).map((session) => session.sessionId)).toEqual([legacy.sessionId, a.sessionId, b.sessionId]);
    expect(await (await reloaded.get('b')).getSelectedTabId()).toBe(b.selectedTabId);
    await expect((await reloaded.get('unknown')).getSelectedTabId()).rejects.toMatchObject({ code: 'session_required' });
    fixture.windows.delete(a.agentWindowId);
    expect((await reloaded.list()).map((session) => session.sessionKey)).toEqual(['default', 'b']);
    expect(await (await reloaded.get('b')).getSelectedTabId()).toBe(b.selectedTabId);
  });

  it('bounds concurrent windows, reuses capacity after stop, and rejects unsafe keys', async () => {
    const registry = new SessionRegistry();
    await Promise.all(Array.from({ length: MAX_BROWSER_SESSIONS }, (_, index) => registry.start(`agent-${index}`)));
    await expect(registry.start('overflow')).rejects.toMatchObject({ code: 'session_capacity_exceeded' });
    await registry.stop('agent-0');
    await expect(registry.start('overflow')).resolves.toMatchObject({ started: true });
    await expect(registry.get('../invalid')).rejects.toMatchObject({ code: 'invalid_session_key' });
    await expect(registry.get('x'.repeat(129))).rejects.toMatchObject({ code: 'invalid_session_key' });
  });

  it('pauses one agent without pausing others and fails closed on resume persistence errors', async () => {
    const registry = new SessionRegistry();
    await Promise.all([registry.start('a'), registry.start('b')]);
    const a = await registry.get('a');
    const b = await registry.get('b');
    await a.setPaused(true);
    expect((await b.requireState()).paused).not.toBe(true);
    fixture.stub.storage.session.set.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(a.setPaused(false)).rejects.toThrow('storage unavailable');
    expect((await a.requireState()).paused).toBe(true);
    expect((await (await new SessionRegistry().get('a')).requireState()).paused).toBe(true);
  });
});
