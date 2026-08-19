import type { SnapshotNode } from './automation';

export const OBSERVE_DELTA_MAX_TABS = 32;
export const OBSERVE_DELTA_MAX_STORED_REFS = 1_000;
export const OBSERVE_DELTA_MAX_RETURNED_NODES = 500;
export const OBSERVE_DELTA_MAX_REMOVED_REFS = 1_000;

export interface ObserveDelta {
  changes: true;
  baseline: boolean;
  added: SnapshotNode[];
  changed: SnapshotNode[];
  removed: string[];
  unchanged: number;
  total_nodes: number;
}

/** Stable content signature for one observed node; excludes the ref itself. */
export function nodeSignature(node: SnapshotNode): string {
  return JSON.stringify([node.tag, node.role ?? '', node.name ?? '', node.text ?? '', node.disabled === true, node.href ?? '']);
}

/**
 * Diff the current observation against the stored one. Returns the bounded
 * delta and the next stored signatures. State is per tab and per document;
 * callers clear it on navigation, tab cleanup, session stop, and disconnect.
 */
export function computeObserveDelta(
  previous: Map<string, string> | undefined,
  nodes: SnapshotNode[],
): { delta: ObserveDelta; next: Map<string, string> } {
  const next = new Map<string, string>();
  for (const node of nodes.slice(0, OBSERVE_DELTA_MAX_STORED_REFS)) {
    next.set(node.ref, nodeSignature(node));
  }
  const added: SnapshotNode[] = [];
  const changed: SnapshotNode[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  for (const node of nodes) {
    const signature = next.get(node.ref);
    if (previous === undefined) {
      if (added.length < OBSERVE_DELTA_MAX_RETURNED_NODES) added.push(node);
      continue;
    }
    const oldSignature = previous.get(node.ref);
    if (oldSignature === undefined) {
      if (added.length < OBSERVE_DELTA_MAX_RETURNED_NODES) added.push(node);
    } else if (oldSignature !== signature) {
      if (added.length + changed.length < OBSERVE_DELTA_MAX_RETURNED_NODES) changed.push(node);
    } else {
      unchanged += 1;
    }
  }
  if (previous !== undefined) {
    for (const ref of previous.keys()) {
      if (!next.has(ref) && removed.length < OBSERVE_DELTA_MAX_REMOVED_REFS) removed.push(ref);
    }
  }
  return {
    delta: {
      changes: true,
      baseline: previous === undefined,
      added,
      changed,
      removed,
      unchanged,
      total_nodes: nodes.length,
    },
    next,
  };
}

/**
 * Bounded per-tab observation state. Oldest tabs are evicted past the tab cap;
 * callers `drop` on navigation/removal/return and `clear` on session stop or
 * native disconnect.
 */
export class ObserveDeltaStore {
  private readonly tabs = new Map<number, Map<string, string>>();

  read(tabId: number): Map<string, string> | undefined {
    return this.tabs.get(tabId);
  }

  write(tabId: number, signatures: Map<string, string>): void {
    this.tabs.delete(tabId);
    this.tabs.set(tabId, signatures);
    while (this.tabs.size > OBSERVE_DELTA_MAX_TABS) {
      const oldest = this.tabs.keys().next();
      if (oldest.done) break;
      this.tabs.delete(oldest.value);
    }
  }

  drop(tabId: number): void {
    this.tabs.delete(tabId);
  }

  clear(): void {
    this.tabs.clear();
  }
}
