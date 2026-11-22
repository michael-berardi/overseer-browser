import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithVisibleOwnedWindow, runWithVisibleOwnedWindowBestEffort } from '../src/screenshot';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An owned Agent Window hidden at its original position and visible once moved clear. */
function stubHiddenOwnedWindow(visibleAt: (left: number, top: number) => boolean) {
  let position = { left: 0, top: 0 };
  const update = vi.fn(async (_id: number, info: { left?: number; top?: number; focused?: boolean; state?: string }) => {
    position = { left: info.left ?? position.left, top: info.top ?? position.top };
    return { id: 7, ...position };
  });
  const get = vi.fn(async () => ({ id: 7, ...position, width: 800, height: 600, state: 'normal' as const }));
  const executeScript = vi.fn(async () => [{
    result: {
      visibility: visibleAt(position.left, position.top) ? 'visible' : 'hidden',
      painted: true,
      scroll: { x: 0, y: 0 },
      frame_at_ms: 1_700_000_000_000,
    },
  }]);
  vi.stubGlobal('browser', { windows: { get, update } });
  vi.stubGlobal('chrome', { scripting: { executeScript } });
  return { update, get, position: () => position };
}

describe('owned window viewability for page work', () => {
  it('runs work only once the owned window is visible, then restores its bounds without focusing it', async () => {
    const { update, position } = stubHiddenOwnedWindow((left) => left >= 1000);
    let workPosition = { left: -1, top: -1 };

    const result = await runWithVisibleOwnedWindow(21, 7, () => undefined, {}, async () => {
      workPosition = { ...position() };
      return 'viewable';
    });

    expect(result).toBe('viewable');
    expect(workPosition).toEqual({ left: 3000, top: 200 });
    expect(position()).toEqual({ left: 0, top: 0 });
    for (const [id, info] of update.mock.calls) {
      expect(id).toBe(7);
      expect(info.focused).toBeUndefined();
      expect(info.state).toBeUndefined();
    }
  });

  it('does not move a window that is already visible', async () => {
    const { update, position } = stubHiddenOwnedWindow(() => true);

    await runWithVisibleOwnedWindow(21, 7, () => undefined, {}, async () => 'done');

    expect(update).not.toHaveBeenCalled();
    expect(position()).toEqual({ left: 0, top: 0 });
  });

  it('runs page work in place when the visibility probe cannot run', async () => {
    const update = vi.fn(async () => ({ id: 7 }));
    vi.stubGlobal('browser', { windows: { get: vi.fn(async () => ({ id: 7, left: 0, top: 0, state: 'normal' })), update } });
    vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn(async () => { throw new Error('probe unavailable'); }) } });
    const work = vi.fn(async () => 'ran-anyway');

    await expect(runWithVisibleOwnedWindowBestEffort(21, 7, () => undefined, work)).resolves.toBe('ran-anyway');
    expect(update).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('never reruns page work when the work itself fails', async () => {
    stubHiddenOwnedWindow(() => true);
    const work = vi.fn(async () => { throw new Error('work failed'); });

    await expect(runWithVisibleOwnedWindowBestEffort(21, 7, () => undefined, work)).rejects.toThrow('work failed');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
