import {it, expect, vi, afterEach} from 'vitest';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function setup(fail = false) {
  vi.resetModules(); vi.useFakeTimers();
  let listener: any; let instance: any;
  const track = {applyConstraints: async () => {}, getSettings: () => ({}), stop: vi.fn(), onended: () => {}};
  vi.stubGlobal('chrome', {runtime: {id: 'self', onMessage: {addListener: (cb: any) => {listener = cb;}}}});
  vi.stubGlobal('navigator', {mediaDevices: {getUserMedia: async () => ({getVideoTracks: () => [track], getTracks: () => [track]})}});
  vi.stubGlobal('document', {createElement: () => ({play: async () => {}, pause: () => {}, requestVideoFrameCallback: () => {}})});
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true; }
    state = 'inactive'; mimeType = 'video/webm'; onstop: any; ondataavailable: any;
    constructor() {instance = this;}
    start() {if (fail) throw new Error('encoder failed'); this.state = 'recording';}
    stop() {this.state = 'inactive'; queueMicrotask(() => this.onstop());}
  });
  await import('../src/recorder');
  const call = (action: string, extra = {}) => new Promise<any>(resolve => listener({destination: 'recorder', action, token: 'owner', fps: 30, seconds: 10, max_bytes: 10, ...extra}, {id: 'self'}, resolve));
  return {call, track, instance: () => instance};
}
it('handles encoder start exception without a never-resolving stop', async () => {
  const b = await setup(true);
  expect((await b.call('start')).phase).toBe('denied');
  expect(b.track.stop).toHaveBeenCalled();
});
it('bounds chunks, isolates tokens, tolerates duplicate stop and expires retained bytes', async () => {
  const b = await setup(); await b.call('start');
  b.instance().ondataavailable({data: new Blob(['abc'])});
  await b.call('stop'); expect((await b.call('stop')).bytes).toBe(3);
  expect((await b.call('chunk', {index: 0, token: 'peer'})).phase).toBe('error');
  expect((await b.call('chunk', {index: 1})).phase).toBe('error');
  expect((await b.call('chunk', {index: 0})).data).toBe('YWJj');
  await vi.advanceTimersByTimeAsync(300000);
  expect((await b.call('status')).bytes).toBe(0);
});
it('stops at byte limit and releases tracks', async () => {
  const b = await setup(); await b.call('start');
  b.instance().ondataavailable({data: new Blob(['01234567890'])});
  await b.call('stop'); expect((await b.call('status')).reason).toBe('byte_limit');
  expect(b.track.stop).toHaveBeenCalled();
});
it('bounds fragment count and clears repeated capture cycles', async () => {
  const b = await setup();
  for (let cycle = 0; cycle < 3; cycle++) {
    await b.call('start', {max_bytes: 67108864});
    for (let i = 0; i < 1201; i++) b.instance().ondataavailable({data: new Blob(['x'])});
    await b.call('stop');
    expect((await b.call('status')).bytes).toBe(1200);
    await b.call('clear');
    expect((await b.call('status', {token: ''})).bytes).toBe(0);
  }
});
it('track end releases capture and retention expires without another capture', async () => {
  const b = await setup(); await b.call('start');
  b.instance().ondataavailable({data: new Blob(['abc'])});
  b.track.onended();
  await b.call('stop');
  expect((await b.call('status')).reason).toBe('capture_ended');
  await vi.advanceTimersByTimeAsync(300000);
  expect((await b.call('status')).bytes).toBe(0);
  expect(b.track.stop).toHaveBeenCalled();
});
