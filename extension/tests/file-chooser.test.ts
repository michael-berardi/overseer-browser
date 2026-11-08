import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverFileChooser, fileChooserCaptured, installFileChooserGuard, runChooserUpload } from '../src/automation';

// Minimal stand-ins for the page globals these MAIN-world functions touch.
class FakeInput {
  type = 'file';
  files: unknown = null;
  events: string[] = [];
  nativeOpened = 0;
  dispatchEvent(event: { type: string }): boolean { this.events.push(event.type); return true; }
}
FakeInput.prototype['click' as keyof FakeInput] = function (this: FakeInput) { this.nativeOpened += 1; } as never;
(FakeInput.prototype as unknown as { showPicker: () => void }).showPicker = function (this: FakeInput) { this.nativeOpened += 1; };

class FakeDataTransfer {
  list: unknown[] = [];
  items = { add: (file: unknown) => { this.list.push(file); } };
  get files() { return this.list; }
}

const file = { filename: 'clip.mp4', mimeType: 'video/mp4', contentBase64: 'AAAA' };

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('DataTransfer', FakeDataTransfer);
  vi.stubGlobal('Event', class { constructor(public type: string) {} });
  vi.stubGlobal('File', class { constructor(public parts: unknown[], public name: string, public opts: unknown) {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).showOpenFilePicker;
});

describe('file chooser guard (MAIN world)', () => {
  it('captures the next file-input click without opening the native picker, then restores the prototype', () => {
    const originalClick = FakeInput.prototype['click' as keyof FakeInput];
    expect(installFileChooserGuard('tok-1')).toBe(true);
    const input = new FakeInput();
    (input as unknown as { click: () => void }).click();
    expect(input.nativeOpened).toBe(0);
    expect(fileChooserCaptured('tok-1')).toBe(true);
    const result = deliverFileChooser('tok-1', [file]);
    expect(result).toEqual({ ok: true, count: 1 });
    expect((input.files as unknown[]).length).toBe(1);
    expect(input.events).toEqual(['input', 'change']);
    expect(FakeInput.prototype['click' as keyof FakeInput]).toBe(originalClick);
    expect((globalThis as Record<string, unknown>)['tok-1']).toBeUndefined();
  });

  it('captures showPicker on a detached input too', () => {
    installFileChooserGuard('tok-2');
    const input = new FakeInput();
    (input as unknown as { showPicker: () => void }).showPicker();
    expect(input.nativeOpened).toBe(0);
    expect(fileChooserCaptured('tok-2')).toBe(true);
    expect(deliverFileChooser('tok-2', [file]).ok).toBe(true);
  });

  it('only intercepts once: a second picker opens normally', () => {
    installFileChooserGuard('tok-3');
    const first = new FakeInput();
    const second = new FakeInput();
    (first as unknown as { click: () => void }).click();
    (second as unknown as { click: () => void }).click();
    expect(first.nativeOpened).toBe(0);
    expect(second.nativeOpened).toBe(1);
    deliverFileChooser('tok-3', null);
  });

  it('resolves showOpenFilePicker with handles whose getFile returns the file', async () => {
    const original = vi.fn(async () => []);
    (globalThis as Record<string, unknown>).showOpenFilePicker = original;
    installFileChooserGuard('tok-4');
    const pending = (globalThis as unknown as { showOpenFilePicker: () => Promise<Array<{ getFile: () => Promise<{ name: string }> }>> }).showOpenFilePicker();
    expect(fileChooserCaptured('tok-4')).toBe(true);
    expect(deliverFileChooser('tok-4', [file])).toEqual({ ok: true, count: 1 });
    const handles = await pending;
    expect((await handles[0].getFile()).name).toBe('clip.mp4');
    expect((globalThis as Record<string, unknown>).showOpenFilePicker).toBe(original);
  });

  it('reports chooser_not_opened when nothing opened a picker, and still restores', () => {
    const originalClick = FakeInput.prototype['click' as keyof FakeInput];
    installFileChooserGuard('tok-5');
    expect(fileChooserCaptured('tok-5')).toBe(false);
    expect(deliverFileChooser('tok-5', [file])).toEqual({ ok: false, code: 'chooser_not_opened' });
    expect(FakeInput.prototype['click' as keyof FakeInput]).toBe(originalClick);
  });

  it('refuses to install twice under the same token', () => {
    expect(installFileChooserGuard('tok-6')).toBe(true);
    expect(installFileChooserGuard('tok-6')).toBe(false);
    deliverFileChooser('tok-6', null);
  });
});

describe('runChooserUpload (background)', () => {
  it('times out with chooser_not_opened and always releases the guard', async () => {
    const calls: string[] = [];
    const executeScript = vi.fn(async ({ func, world }: { func: { name: string }; world: string }) => {
      calls.push(`${world}:${func.name}`);
      if (func.name === 'installFileChooserGuard' || func.name === 'installDialogGuards') return [{ result: true }];
      if (func.name === 'fileChooserCaptured') return [{ result: false }];
      if (func.name === 'isolatedAutomation') return [{ result: { ok: true, value: { changed: true }, dialogs: [] } }];
      return [{ result: { ok: true, count: 0 } }];
    });
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid' });
    await expect(runChooserUpload(1, 'osr-media', [file], 250)).rejects.toMatchObject({ code: 'chooser_not_opened' });
    expect(calls[0]).toBe('MAIN:installFileChooserGuard');
    expect(calls.at(-1)).toBe('MAIN:deliverFileChooser');
  });

  it('refuses an oversized upload before touching the page', async () => {
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    const big = { ...file, contentBase64: 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 3) / 3) * 4) };
    await expect(runChooserUpload(1, 'osr-media', [big])).rejects.toMatchObject({ code: 'upload_too_large' });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
