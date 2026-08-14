import { describe, expect, it, vi } from 'vitest';
import { installDialogGuards, isBoundedUpload, runInIsolatedWorld, runPageEvaluation, snapshotPriorityForNode, stableRefForPath } from '../src/automation';

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


  it('returns stable automation errors from the isolated executor', async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { ok: false, error: { code: 'stale_ref', message: 'The element reference is no longer present in the target document.', fallback: 'Observe the page again and retry with a current ref.' } } }])
      .mockResolvedValueOnce([{ result: [] }]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });

    await expect(runInIsolatedWorld(7, { kind: 'click', ref: 'osr-stale' })).rejects.toMatchObject({
      code: 'stale_ref',
      message: 'The element reference is no longer present in the target document.',
      fallback: 'Observe the page again and retry with a current ref.',
    });
  });

  it('returns bounded dialog results instead of leaving click blocked', async () => {
    const dialog = { type: 'confirm', message: 'Continue?', response: false };
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: { ok: true, value: { changed: true } } }])
      .mockResolvedValueOnce([{ result: [dialog] }]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });

    await expect(runInIsolatedWorld(7, { kind: 'click', ref: 'osr-confirm' })).resolves.toEqual({
      changed: true,
      dialogs: [dialog],
    });
    expect(executeScript).toHaveBeenCalledTimes(3);
  });

  it('rejects missing isolated-world envelopes instead of reporting false success', async () => {
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn()
          .mockResolvedValueOnce([{ result: true }])
          .mockResolvedValueOnce([{ result: null }])
          .mockResolvedValueOnce([{ result: [] }]),
      },
    });

    await expect(runInIsolatedWorld(7, { kind: 'click', ref: 'osr-stale' })).rejects.toMatchObject({
      code: 'automation_failed',
      message: 'Browser automation failed in the target tab.',
    });
  });

  it('returns a structured error for page-world evaluation failures', async () => {
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async () => [{
          result: { ok: false, error: { code: 'evaluation_failed', message: 'Page evaluation failed in the target tab.' } },
        }]),
      },
    });

    await expect(runPageEvaluation(7, 'invalid; expression')).rejects.toMatchObject({
      code: 'evaluation_failed',
      message: 'Page evaluation failed in the target tab.',
    });
  });

  it('rejects non-serializable evaluation results with their stable code', async () => {
    vi.stubGlobal('chrome', {
      scripting: {
        executeScript: vi.fn(async () => [{
          result: { ok: false, error: { code: 'evaluation_result_invalid', message: 'Page evaluation must return a JSON-serializable value.' } },
        }]),
      },
    });

    await expect(runPageEvaluation(7, '1n')).rejects.toMatchObject({
      code: 'evaluation_result_invalid',
      message: 'Page evaluation must return a JSON-serializable value.',
    });
  });


  it('collects partial frame guards before reporting installation failure', async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ result: false }])
      .mockResolvedValueOnce([{ result: [] }]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });

    await expect(runInIsolatedWorld(7, { kind: 'click', ref: 'osr-action' })).rejects.toMatchObject({
      code: 'dialog_guard_failed',
    });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenNthCalledWith(2, expect.objectContaining({ world: 'MAIN' }));
  });
  it('rolls back partially installed dialog guards', () => {
    const originalAlert = vi.fn();
    const originalConfirm = vi.fn(() => true);
    const originalPrompt = vi.fn(() => 'value');
    const fakeDocument = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const fakeWindow = {
      alert: originalAlert,
      confirm: originalConfirm,
      prompt: originalPrompt,
      frames: [],
      document: fakeDocument,
    } as unknown as Window;
    Object.defineProperty(fakeWindow, 'confirm', {
      value: originalConfirm,
      configurable: false,
      writable: false,
    });
    vi.stubGlobal('window', fakeWindow);

    expect(installDialogGuards('dialog-test-token')).toBe(false);
    expect(fakeWindow.alert).toBe(originalAlert);
    expect((fakeWindow as unknown as Record<string, unknown>)['dialog-test-token']).toBeUndefined();
    expect(fakeDocument.removeEventListener).toHaveBeenCalledWith('dialog-test-token', expect.any(Function));
  });

  it('restores dialog globals from the in-page cleanup signal without extension reinjection', () => {
    const originalAlert = vi.fn();
    const originalConfirm = vi.fn(() => true);
    const originalPrompt = vi.fn(() => 'value');
    let release!: EventListener;
    const fakeDocument = {
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        release = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const fakeWindow = {
      alert: originalAlert,
      confirm: originalConfirm,
      prompt: originalPrompt,
      frames: [],
      document: fakeDocument,
    } as unknown as Window;
    vi.stubGlobal('window', fakeWindow);

    expect(installDialogGuards('dialog-release-token')).toBe(true);
    expect(fakeWindow.alert).not.toBe(originalAlert);
    release({} as Event);
    expect(fakeWindow.alert).toBe(originalAlert);
    expect((fakeWindow as unknown as Record<string, unknown>)['dialog-release-token']).toBeDefined();
  });
});
