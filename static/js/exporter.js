// Exports: still images straight from a full-size WebGL canvas, and seamless video loops rendered frame by frame
// and encoded in the browser with WebCodecs (VP9, VP8 as a fallback), then written as WebM by webm.js.

import { GradientRenderer } from './renderer.js';
import { muxWebM } from './webm.js';
import { loopCount } from './sizes.js';

export const IMAGE_TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function exportImage(doc, { ext = 'png', w, h, t = 0, quality = 0.95 }) {
  const canvas = makeCanvas(w, h);
  const r = new GradientRenderer(canvas, { preserve: true });
  try {
    r.render(doc, t, { frame: 0 });
    const blob = await new Promise((res) => canvas.toBlob(res, IMAGE_TYPES[ext] || 'image/png', quality));
    if (!blob) throw new Error('The browser could not encode the image.');
    return blob;
  } finally {
    r.dispose();
  }
}

const CODECS = [
  { codec: 'vp09.00.51.08', kind: 'vp9' },
  { codec: 'vp09.00.41.08', kind: 'vp9' },
  { codec: 'vp09.00.10.08', kind: 'vp9' },
  { codec: 'vp8', kind: 'vp8' },
];

export async function pickCodec(w, h, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const c of CODECS) {
    const cfg = { codec: c.codec, width: w, height: h, framerate: fps, bitrate, latencyMode: 'quality', bitrateMode: 'variable' };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return { ...c, cfg: s.config || cfg };
    } catch { /* try the next one */ }
  }
  return null;
}

export const videoBitrate = (w, h, fps) => Math.round(Math.min(80e6, Math.max(8e6, w * h * fps * 0.22)));

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Renders `seconds` of animation at `fps` into a WebM Blob. The animation is fitted to a whole number of loops,
 * so the last frame flows straight back into the first.
 */
export async function exportVideo(doc, { w, h, fps = 30, seconds = 5, onProgress = () => {}, signal } = {}) {
  const total = Math.round(fps * seconds);
  const loops = loopCount(seconds, doc.motion.duration);
  const bitrate = videoBitrate(w, h, fps);
  const pick = await pickCodec(w, h, fps, bitrate);
  if (!pick) throw new Error('This browser cannot encode video (WebCodecs VP9/VP8 missing).');

  const canvas = makeCanvas(w, h);
  const r = new GradientRenderer(canvas, { preserve: true });
  const frames = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(pick.cfg);
  const frameUs = 1e6 / fps;
  try {
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure) throw failure;
      r.render(doc, (i / total) * loops, { frame: i });
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 4) {
        await new Promise((res) => setTimeout(res, 2));
        if (failure) throw failure;
      }
      if (i % 3 === 0) { onProgress((i + 1) / total * 0.97); await tick(); }
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    r.dispose();
  }
  frames.sort((a, b) => a.timestampUs - b.timestampUs);
  const { parts } = muxWebM({ width: w, height: h, fps, codec: pick.kind, frames, durationUs: total * frameUs });
  onProgress(1);
  return { blob: new Blob(parts, { type: 'video/webm' }), codec: pick.codec, frames: frames.length, loops };
}
