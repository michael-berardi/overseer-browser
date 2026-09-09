import { RECORD_CHUNK } from '../src/recording';
const MAX_CHUNKS = 1200;
function discard() {
  blob = new Blob(); chunks = []; bytes = 0;
  video?.pause(); if (video) video.srcObject = null;
  video = undefined; stream = undefined; recorder = undefined;
}
let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let blob = new Blob();
let chunks: Blob[] = [];
let bytes = 0;
let phase = 'idle';
let reason = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let started = 0;
let retention: ReturnType<typeof setTimeout> | undefined;
let owner = '';
let generation = 0;
let ended = 0;
let settings: MediaTrackSettings = {};
let frames = 0;
let video: HTMLVideoElement | undefined;
let done: Promise<void> = Promise.resolve();
let finish: () => void = () => {};
async function stop() {
  clearTimeout(timer);
  if (recorder && recorder.state !== 'inactive') { if (phase !== 'stopping') { phase = 'stopping'; recorder.stop(); } }
  else stream?.getTracks().forEach(t => t.stop());
  await done;
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !!sender.tab || (sender.url !== undefined && sender.url !== chrome.runtime.getURL('background.js')) || m?.destination !== 'recorder') return false;
  void (async () => {
    if (m.action !== 'start' && m.action !== 'clear' && m.token !== owner) throw new Error('recording_wrong_session');
    if (m.action === 'start') {
      if (phase === 'starting' || phase === 'recording' || phase === 'stopping') throw new Error('Recorder busy');
      if (!Number.isFinite(m.seconds) || m.seconds < 1 || m.seconds > 300 || !Number.isFinite(m.max_bytes) || m.max_bytes < 1) throw new Error('Invalid recording bounds');
      const current = ++generation;
      owner = m.token; clearTimeout(retention); ended = 0;
      await stop(); chunks = []; blob = new Blob(); bytes = 0; frames = 0; reason = ''; phase = 'starting';
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: m.streamId, maxFrameRate: m.fps } } as MediaTrackConstraints });
        if (current !== generation) { stream.getTracks().forEach(t => t.stop()); throw new Error('Capture cancelled'); }
        const track = stream.getVideoTracks()[0]!;
        await track.applyConstraints({ frameRate: { ideal: m.fps, max: m.fps } });
        if (current !== generation) throw new Error('Capture cancelled');
        settings = track.getSettings();
        const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(x => MediaRecorder.isTypeSupported(x));
        if (!mimeType) throw new Error('No WebM MediaRecorder codec');
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2000000 });
        done = new Promise(resolve => { finish = resolve; });
        recorder.ondataavailable = e => {
          if (current !== generation) return;
          if (chunks.length >= MAX_CHUNKS || bytes + e.data.size > Math.min(m.max_bytes, 64 * 1024 * 1024)) { reason = 'byte_limit'; void stop(); return; }
          if (e.data.size) { chunks.push(e.data); bytes += e.data.size; }
        };
        recorder.onstop = () => { stream?.getTracks().forEach(t => t.stop()); video?.pause(); if (video) video.srcObject = null; blob = new Blob(chunks, { type: mimeType }); chunks = []; phase = 'stopped'; ended = Date.now(); finish();
          retention = setTimeout(() => { discard(); phase = 'expired'; }, 300000); };
        recorder.onerror = () => { reason = 'encoder_error'; void stop(); };
        track.onended = () => { reason = 'capture_ended'; void stop(); };
        video = document.createElement('video'); video.muted = true; video.srcObject = stream;
        const count = () => { frames++; if (phase === 'recording') video?.requestVideoFrameCallback(count); };
        try { recorder.start(250); } catch (e) { finish(); throw e; } started = Date.now(); phase = 'recording';
        timer = setTimeout(() => { reason = 'duration_limit'; void stop(); }, m.seconds * 1000);
        await video.play();
        if (current === generation && phase === 'recording') video?.requestVideoFrameCallback(count);
      } catch (e) { reason = String(e); await stop(); clearTimeout(retention); discard(); phase = 'denied'; }
    }
    if (m.action === 'stop') await stop();
    if (m.action === 'chunk') {
      if (phase !== 'stopped' || !Number.isInteger(m.index) || m.index < 0 || m.index * RECORD_CHUNK >= bytes) throw new Error('Invalid chunk');
      const data = new Uint8Array(await blob.slice(m.index * RECORD_CHUNK, (m.index + 1) * RECORD_CHUNK).arrayBuffer());
      let text = ''; for (const b of data) text += String.fromCharCode(b);
      return { data: btoa(text), index: m.index };
    }
    if (m.action === 'clear') { generation++; await stop(); clearTimeout(retention); owner = ''; discard(); phase = 'idle'; }
    return { phase, reason, bytes, chunks: Math.ceil(bytes / RECORD_CHUNK), mime_type: blob.type || recorder?.mimeType, requested_fps: m.fps, track_settings: settings, observed_presented_frames: frames, frame_evidence: 'video requestVideoFrameCallback, not encoded frame count; use ffprobe', elapsed_ms: started ? (ended || Date.now()) - started : 0 };
  })().then(reply, e => reply({ phase: 'error', reason: String(e) }));
  return true;
});
