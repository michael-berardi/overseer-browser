import { describe, expect, it } from 'vitest';
import type { SnapshotNode } from '../src/automation';
import {
  OBSERVE_DELTA_MAX_REMOVED_REFS,
  OBSERVE_DELTA_MAX_RETURNED_NODES,
  OBSERVE_DELTA_MAX_STORED_REFS,
  OBSERVE_DELTA_MAX_TABS,
  ObserveDeltaStore,
  computeObserveDelta,
} from '../src/observe_delta';

const node = (ref: string, overrides: Partial<SnapshotNode> = {}): SnapshotNode => ({ ref, tag: 'div', ...overrides });

describe('observe delta computation', () => {
  it('reports the first observation as a bounded baseline of added nodes', () => {
    const nodes = [node('osr-a'), node('osr-b', { text: 'hello' })];
    const { delta, next } = computeObserveDelta(undefined, nodes);
    expect(delta.baseline).toBe(true);
    expect(delta.added).toEqual(nodes);
    expect(delta.changed).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.total_nodes).toBe(2);
    expect(next.size).toBe(2);
  });

  it('reports added, changed, removed, and unchanged refs against the baseline', () => {
    const baseline = [node('osr-a', { text: 'one' }), node('osr-b', { text: 'two' }), node('osr-c')];
    const { next } = computeObserveDelta(undefined, baseline);
    const current = [node('osr-a', { text: 'one' }), node('osr-b', { text: 'edited' }), node('osr-d')];
    const { delta } = computeObserveDelta(next, current);
    expect(delta.baseline).toBe(false);
    expect(delta.unchanged).toBe(1);
    expect(delta.added.map((entry) => entry.ref)).toEqual(['osr-d']);
    expect(delta.changed.map((entry) => entry.ref)).toEqual(['osr-b']);
    expect(delta.removed).toEqual(['osr-c']);
  });

  it('treats disabled and href changes as changes', () => {
    const { next } = computeObserveDelta(undefined, [node('osr-a', { tag: 'button', disabled: false })]);
    const { delta } = computeObserveDelta(next, [node('osr-a', { tag: 'button', disabled: true })]);
    expect(delta.changed.map((entry) => entry.ref)).toEqual(['osr-a']);
  });

  it('does not collide signatures across field boundaries', () => {
    const before = computeObserveDelta(undefined, [node('osr-a', { tag: 'ab', role: 'c', text: 'x' })]);
    const after = computeObserveDelta(before.next, [node('osr-a', { tag: 'a', role: 'bc', text: 'x' })]);
    expect(after.delta.changed.map((entry) => entry.ref)).toEqual(['osr-a']);
    expect(after.delta.unchanged).toBe(0);
  });

  it('bounds stored refs and returned delta lists', () => {
    const many = Array.from({ length: OBSERVE_DELTA_MAX_STORED_REFS + 100 }, (_value, index) => node(`osr-${index}`));
    const { delta, next } = computeObserveDelta(undefined, many);
    expect(next.size).toBe(OBSERVE_DELTA_MAX_STORED_REFS);
    expect(delta.added.length).toBe(OBSERVE_DELTA_MAX_RETURNED_NODES);
    expect(delta.total_nodes).toBe(many.length);
    const removedHeavy = computeObserveDelta(next, []);
    expect(removedHeavy.delta.removed.length).toBe(OBSERVE_DELTA_MAX_REMOVED_REFS);
  });
});

describe('observe delta store', () => {
  it('evicts the oldest tab past the tab cap and drops tabs explicitly', () => {
    const store = new ObserveDeltaStore();
    for (let tab = 1; tab <= OBSERVE_DELTA_MAX_TABS + 2; tab += 1) {
      store.write(tab, new Map([['osr-a', 'sig']]));
    }
    expect(store.read(1)).toBeUndefined();
    expect(store.read(2)).toBeUndefined();
    expect(store.read(3)).toBeDefined();
    store.drop(3);
    expect(store.read(3)).toBeUndefined();
    store.clear();
    expect(store.read(OBSERVE_DELTA_MAX_TABS + 2)).toBeUndefined();
  });

  it('rewriting a tab refreshes its eviction recency', () => {
    const store = new ObserveDeltaStore();
    for (let tab = 1; tab <= OBSERVE_DELTA_MAX_TABS; tab += 1) store.write(tab, new Map());
    store.write(1, new Map([['osr-b', 'sig']]));
    store.write(OBSERVE_DELTA_MAX_TABS + 1, new Map());
    expect(store.read(1)).toBeDefined();
    expect(store.read(2)).toBeUndefined();
  });
});
