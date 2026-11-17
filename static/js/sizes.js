// Canvas formats and every export-size rule, kept DOM-free so the tests can check them.

export const MAX_EDGE = 4096;

export const FORMATS = [
  { id: 'portrait', label: 'Portrait', ratio: '5:8', w: 900, h: 1440 },
  { id: 'story', label: 'Story / Reel', ratio: '9:16', w: 1080, h: 1920 },
  { id: 'post', label: 'Post', ratio: '4:5', w: 1080, h: 1350 },
  { id: 'square', label: 'Square', ratio: '1:1', w: 1200, h: 1200 },
  { id: 'landscape', label: 'Landscape', ratio: '16:10', w: 1440, h: 900 },
  { id: 'wide', label: 'Widescreen', ratio: '16:9', w: 1920, h: 1080 },
  { id: 'banner', label: 'Banner', ratio: '3:1', w: 1500, h: 500 },
];

export const VIDEO_SIZES = [
  { id: 'hd', label: 'HD', edge: 1920 },
  { id: 'qhd', label: '2K', edge: 2560 },
  { id: '4k', label: '4K', edge: 3840 },
];

export function formatById(id) {
  return FORMATS.find((f) => f.id === id) || null;
}

export function clampDim(v) {
  return Math.max(16, Math.min(MAX_EDGE, Math.round(Number(v) || 0)));
}

/** Image export: base size x multiplier. ok=false when the long edge would pass 4096 px. */
export function imageSize(w, h, mult = 1) {
  const W = Math.round(w * mult), H = Math.round(h * mult);
  return { w: W, h: H, ok: Math.max(W, H) <= MAX_EDGE && Math.min(W, H) >= 1 };
}

/** Video export: the canvas shape scaled so its long edge matches the chosen size, with even sides (VP9 4:2:0). */
export function videoSize(w, h, sizeId = 'hd') {
  const edge = (VIDEO_SIZES.find((v) => v.id === sizeId) || VIDEO_SIZES[0]).edge;
  const s = Math.min(edge, MAX_EDGE) / Math.max(w, h);
  const even = (v) => Math.max(2, 2 * Math.round((v * s) / 2));
  return { w: Math.min(even(w), MAX_EDGE), h: Math.min(even(h), MAX_EDGE) };
}

/** Whole loops that fit the export length, so the file always ends exactly where it began. */
export function loopCount(exportSeconds, loopSeconds) {
  return Math.max(1, Math.round(exportSeconds / Math.max(0.1, loopSeconds)));
}

/** File name stem: the gradient's own name, or its palette name while it is still untitled. */
export function fileStem(doc, w, h, extra = '') {
  const base = doc.name && doc.name.trim() && doc.name.trim() !== 'Untitled gradient' ? doc.name.trim() : doc.paletteName || 'Gradient';
  return `${base} ${w}x${h}${extra ? ' ' + extra : ''}`;
}
