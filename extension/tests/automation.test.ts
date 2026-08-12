import { describe, expect, it } from 'vitest';
import { isBoundedUpload, snapshotPriorityForNode, stableRefForPath } from '../src/automation';

describe('isolated automation contracts', () => {
  it('generates deterministic opaque stable refs from DOM paths', () => {
    expect(stableRefForPath('html:0/body:1/button:2')).toBe(stableRefForPath('html:0/body:1/button:2'));
    expect(stableRefForPath('html:0/body:1/button:2')).toMatch(/^osr-[a-z0-9]+$/);
    expect(stableRefForPath('html:0/body:1/button:2')).not.toBe(stableRefForPath('html:0/body:1/input:2'));
  });

  it('prioritizes actionable and semantic snapshot nodes without changing their refs', () => {
    expect(snapshotPriorityForNode({ tag: 'button', name: 'Save' })).toBe(0);
    expect(snapshotPriorityForNode({ tag: 'a', href: 'https://example.test/' })).toBe(0);
    expect(snapshotPriorityForNode({ tag: 'h2', name: 'Results' })).toBe(1);
    expect(snapshotPriorityForNode({ tag: 'div', role: 'status' })).toBe(1);
    expect(snapshotPriorityForNode({ tag: 'div' })).toBe(2);
    expect(stableRefForPath('html:0/body:1/button:2')).toBe(stableRefForPath('html:0/body:1/button:2'));
  });

  it('bounds upload metadata and content', () => {
    const base = { kind: 'upload' as const, ref: 'osr-abc', filename: 'notes.txt', mimeType: 'text/plain' };
    expect(isBoundedUpload({ ...base, contentBase64: 'SGk=' })).toBe(true);
    expect(isBoundedUpload({ ...base, filename: 'résumé (final).txt', contentBase64: '' })).toBe(true);
    expect(isBoundedUpload({ ...base, filename: '../notes.txt', contentBase64: 'SGk=' })).toBe(false);
    expect(isBoundedUpload({ ...base, filename: 'bad\\name.txt', contentBase64: 'SGk=' })).toBe(false);
    expect(isBoundedUpload({ ...base, filename: 'bad\u0000name.txt', contentBase64: 'SGk=' })).toBe(false);
    expect(isBoundedUpload({ ...base, contentBase64: 'A'.repeat(12 * 1024 * 1024) })).toBe(false);
  });
});
