import { describe, expect, it, vi } from 'vitest';
import { isBoundedUpload, runPageEvaluation, snapshotPriorityForNode, stableRefForPath } from '../src/automation';

const uploadBase = {
  kind: 'upload' as const,
  ref: 'osr-abc',
};

const file = (overrides: Partial<{ filename: string; mimeType: string; contentBase64: string }> = {}) => ({
  filename: 'notes.txt',
  mimeType: 'text/plain',
  contentBase64: 'SGk=',
  ...overrides,
});

const base64ForByteCount = (byteCount: number): string => {
  const fullTriples = Math.floor(byteCount / 3);
  const remainder = byteCount % 3;
  return `${'A'.repeat(fullTriples * 4)}${remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : ''}`;
};

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

  it('accepts bounded multi-file uploads', () => {
    expect(isBoundedUpload({ ...uploadBase, files: [file(), file({ filename: 'image.png', mimeType: 'image/png' })] })).toBe(true);
    expect(isBoundedUpload({ ...uploadBase, files: Array.from({ length: 16 }, () => file()) })).toBe(true);
    expect(isBoundedUpload({ ...uploadBase, files: [file({ filename: 'résumé (final).txt', contentBase64: '' })] })).toBe(true);
  });

  it('rejects empty, over-count, and aggregate-oversized file sets', () => {
    expect(isBoundedUpload({ ...uploadBase, files: [] })).toBe(false);
    expect(isBoundedUpload({ ...uploadBase, files: Array.from({ length: 17 }, () => file()) })).toBe(false);
    const first = file({ contentBase64: base64ForByteCount(8 * 1024 * 1024 - 1) });
    const exactLimit = file({ contentBase64: base64ForByteCount(1) });
    const oversized = file({ contentBase64: base64ForByteCount(2) });
    expect(isBoundedUpload({ ...uploadBase, files: [first] })).toBe(true);
    expect(isBoundedUpload({ ...uploadBase, files: [first, exactLimit] })).toBe(true);
    expect(isBoundedUpload({ ...uploadBase, files: [first, oversized] })).toBe(false);
  });

  it('rejects unsafe metadata and malformed base64 in any file', () => {
    expect(isBoundedUpload({ ...uploadBase, files: [file({ filename: '../notes.txt' })] })).toBe(false);
    expect(isBoundedUpload({ ...uploadBase, files: [file({ filename: 'bad\\name.txt' })] })).toBe(false);
    expect(isBoundedUpload({ ...uploadBase, files: [file({ filename: 'bad\u0000name.txt' })] })).toBe(false);
    expect(isBoundedUpload({ ...uploadBase, files: [file({ mimeType: 'text/plain; charset=utf-8' })] })).toBe(false);
    expect(isBoundedUpload({ ...uploadBase, files: [file({ contentBase64: 'not base64' })] })).toBe(false);
  });

  it('does not accept the removed single-file upload shape', () => {
    expect(isBoundedUpload({
      ...uploadBase,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      contentBase64: 'SGk=',
    } as never)).toBe(false);
  });

  it('returns a structured error for page-world evaluation failures', async () => {
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async () => [{ error: 'Uncaught SyntaxError: secret source' }]),
      },
    });

    await expect(runPageEvaluation(7, 'invalid; expression')).rejects.toMatchObject({
      code: 'evaluation_failed',
      message: 'Page evaluation failed in the target tab.',
    });
  });
});
