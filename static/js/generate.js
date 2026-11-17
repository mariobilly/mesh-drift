// Seeded generation: palettes, point arrangements, shape, motion and finish for a fresh gradient.
// The same seed always gives the same gradient. Locked points survive every re-roll.

import { oklchToHex, hexToOklch, normalizeHex } from './color.js';
import { FORMATS } from './sizes.js';

export const MAX_POINTS = 16;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  if (globalThis.crypto && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

export const seedLabel = (seed) => (seed >>> 0).toString(16).toUpperCase().padStart(8, '0');

const R = (rng, a, b) => a + (b - a) * rng();
const RI = (rng, a, b) => Math.floor(R(rng, a, b + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const wrapHue = (h) => ((h % 360) + 360) % 360;

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- palettes (built in OKLCH so lightness steps look even) ------------------------------------------------
// Each strategy returns n colours. The names feed the palette label shown in the corner (e.g. "Duotone Haze").
const STRATEGIES = {
  duotone(rng, n) {
    const h1 = R(rng, 0, 360), h2 = wrapHue(h1 + R(rng, 110, 190));
    const base = [[0.16, 0.07, h1], [0.63, 0.21, h1], [0.75, 0.19, h2], [0.48, 0.2, h2], [0.88, 0.08, h1 + 20]];
    return fill(rng, base, n, (i) => [R(rng, 0.3, 0.85), R(rng, 0.12, 0.2), i % 2 ? h1 : h2]);
  },
  analogous(rng, n) {
    const h0 = R(rng, 0, 360), span = R(rng, 50, 110), dir = rng() < 0.5 ? -1 : 1;
    return Array.from({ length: n }, (_, i) => [R(rng, 0.3, 0.88), R(rng, 0.14, 0.24), h0 + dir * (span * i) / Math.max(1, n - 1)]);
  },
  complementary(rng, n) {
    const h = R(rng, 0, 360);
    return Array.from({ length: n }, (_, i) => [R(rng, 0.3, 0.88), R(rng, 0.14, 0.24), i % 2 ? h + R(rng, -15, 15) : h + 180 + R(rng, -15, 15)]);
  },
  triadic(rng, n) {
    const h = R(rng, 0, 360);
    return Array.from({ length: n }, (_, i) => [R(rng, 0.45, 0.88), R(rng, 0.14, 0.22), h + 120 * (i % 3) + R(rng, -10, 10)]);
  },
  midnight(rng, n) {
    const h = R(rng, 200, 290);
    const accents = [R(rng, 0, 360)];
    accents.push(wrapHue(accents[0] + R(rng, 120, 200)));
    const out = [[R(rng, 0.1, 0.17), R(rng, 0.02, 0.06), h], [R(rng, 0.14, 0.22), R(rng, 0.03, 0.08), h + 20]];
    for (let i = out.length; i < n; i++) out.push([R(rng, 0.6, 0.9), R(rng, 0.18, 0.3), pick(rng, accents)]);
    return out;
  },
  pastel(rng, n) {
    const h = R(rng, 0, 360);
    return Array.from({ length: n }, (_, i) => [R(rng, 0.8, 0.94), R(rng, 0.06, 0.12), h + i * R(rng, 40, 80)]);
  },
  neon(rng, n) {
    const out = [[R(rng, 0.08, 0.16), R(rng, 0.03, 0.08), R(rng, 260, 320)]];
    const h = R(rng, 0, 360);
    for (let i = 1; i < n; i++) out.push([R(rng, 0.6, 0.78), 0.32, h + i * R(rng, 70, 140)]);
    return out;
  },
  sunset(rng, n) {
    const hues = [R(rng, 15, 40), R(rng, 45, 75), R(rng, 330, 360), R(rng, 280, 310), R(rng, 20, 60)];
    return Array.from({ length: n }, (_, i) => [R(rng, 0.4, 0.86), R(rng, 0.15, 0.24), hues[i % hues.length]]);
  },
  mono(rng, n) {
    const h = R(rng, 0, 360), c = R(rng, 0.1, 0.2);
    return Array.from({ length: n }, (_, i) => [0.14 + (0.8 * i) / Math.max(1, n - 1), c * R(rng, 0.6, 1.1), h + R(rng, -8, 8)]);
  },
  aurora(rng, n) {
    const out = [[R(rng, 0.1, 0.18), R(rng, 0.03, 0.07), R(rng, 220, 260)]];
    const hues = [R(rng, 150, 175), R(rng, 280, 310), R(rng, 185, 210)];
    for (let i = 1; i < n; i++) out.push([R(rng, 0.55, 0.88), R(rng, 0.15, 0.24), hues[(i - 1) % 3]]);
    return out;
  },
  earth(rng, n) {
    return Array.from({ length: n }, () => [R(rng, 0.25, 0.85), R(rng, 0.05, 0.12), R(rng, 30, 110)]);
  },
  ocean(rng, n) {
    const out = Array.from({ length: n - 1 }, () => [R(rng, 0.2, 0.8), R(rng, 0.1, 0.2), R(rng, 190, 260)]);
    out.push([R(rng, 0.85, 0.93), R(rng, 0.03, 0.06), R(rng, 70, 90)]);
    return out;
  },
};

function fill(rng, base, n, extra) {
  const out = shuffle(rng, base).slice(0, n);
  for (let i = out.length; i < n; i++) out.push(extra(i));
  return out;
}

const ADJ = {
  duotone: ['Duotone', 'Split', 'Twin', 'Dual'], analogous: ['Velvet', 'Silk', 'Soft', 'Warm', 'Cool'],
  complementary: ['Contrast', 'Opposite', 'Polar', 'Echo'], triadic: ['Prism', 'Carnival', 'Tri', 'Spectrum'],
  midnight: ['Midnight', 'Nocturne', 'After Dark', 'Eclipse'], pastel: ['Pastel', 'Powder', 'Cloud', 'Sorbet'],
  neon: ['Neon', 'Electric', 'Laser', 'Club'], sunset: ['Sunset', 'Golden', 'Ember', 'Solar'],
  mono: ['Mono', 'Tonal', 'Single', 'Ink'], aurora: ['Aurora', 'Boreal', 'Polar', 'Northern'],
  earth: ['Clay', 'Sand', 'Stone', 'Terra'], ocean: ['Ocean', 'Lagoon', 'Coastal', 'Deep'],
};
const NOUN = ['Haze', 'Bloom', 'Drift', 'Mist', 'Glow', 'Tide', 'Aura', 'Dusk', 'Dawn', 'Wave', 'Fog', 'Flare', 'Veil',
  'Dream', 'Light', 'Field', 'Pulse', 'Current', 'Smoke', 'Silk'];

export const STRATEGY_IDS = Object.keys(STRATEGIES);

// How often each strategy comes up: rich, contrasty families more often than the quiet ones.
const WEIGHTS = { duotone: 3, midnight: 3, neon: 2, sunset: 2, aurora: 2, analogous: 2, complementary: 2, triadic: 1,
  pastel: 1, ocean: 1.5, mono: 1, earth: 0.5 };
function pickStrategy(rng) {
  const total = STRATEGY_IDS.reduce((s, k) => s + WEIGHTS[k], 0);
  let r = rng() * total;
  for (const k of STRATEGY_IDS) { r -= WEIGHTS[k]; if (r < 0) return k; }
  return STRATEGY_IDS[0];
}

export function makePalette(rng, n, strategy = pickStrategy(rng)) {
  const lch = STRATEGIES[strategy](rng, n);
  // Contrast anchor: a palette whose lightness barely varies looks flat, so give it a deep or a bright colour.
  if (n >= 3 && strategy !== 'pastel' && strategy !== 'mono') {
    const Ls = lch.map((c) => c[0]);
    if (Math.max(...Ls) - Math.min(...Ls) < 0.42) {
      const avg = Ls.reduce((a, b) => a + b, 0) / n;
      if (avg > 0.45 || rng() < 0.5) { const k = Ls.indexOf(Math.min(...Ls)); lch[k] = [R(rng, 0.12, 0.22), lch[k][1] * 0.6, lch[k][2]]; }
      else { const k = Ls.indexOf(Math.max(...Ls)); lch[k] = [R(rng, 0.86, 0.94), lch[k][1] * 0.5, lch[k][2]]; }
    }
  }
  const colors = lch.map(([L, C, h]) => oklchToHex(L, C, wrapHue(h)));
  return { strategy, colors, name: `${pick(rng, ADJ[strategy])} ${pick(rng, NOUN)}` };
}

// ---- point arrangements (uv 0..1, origin top-left) -------------------------------------------------------
const ARRANGEMENTS = {
  scatter(rng, n) {
    const pts = [];
    for (let tries = 0; pts.length < n && tries < 400; tries++) {
      const p = [R(rng, 0.04, 0.96), R(rng, 0.04, 0.96)];
      const minD = tries < 300 ? 0.3 : 0.12;
      if (pts.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > minD)) pts.push(p);
    }
    while (pts.length < n) pts.push([R(rng, 0, 1), R(rng, 0, 1)]);
    return pts;
  },
  corners(rng, n) {
    const anchors = shuffle(rng, [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95], [0.5, 0.5], [0.5, 0.05], [0.05, 0.5], [0.95, 0.5], [0.5, 0.95]]);
    return Array.from({ length: n }, (_, i) => {
      const a = anchors[i % anchors.length];
      return [clamp01(a[0] + R(rng, -0.08, 0.08)), clamp01(a[1] + R(rng, -0.08, 0.08))];
    });
  },
  diagonal(rng, n) {
    const ang = R(rng, 0, Math.PI * 2), d = [Math.cos(ang), Math.sin(ang)], perp = [-d[1], d[0]];
    return Array.from({ length: n }, (_, i) => {
      const s = (i / Math.max(1, n - 1) - 0.5) * 1.1, o = R(rng, -0.22, 0.22);
      return [clamp01(0.5 + d[0] * s + perp[0] * o), clamp01(0.5 + d[1] * s + perp[1] * o)];
    });
  },
  edges(rng, n) {
    return Array.from({ length: n }, (_, i) => {
      const side = (i + RI(rng, 0, 3)) % 4, t = R(rng, 0.05, 0.95), e = R(rng, 0.0, 0.08);
      return side === 0 ? [t, e] : side === 1 ? [1 - e, t] : side === 2 ? [t, 1 - e] : [e, t];
    });
  },
  ring(rng, n) {
    const r = R(rng, 0.28, 0.42), a0 = R(rng, 0, Math.PI * 2);
    const pts = [[0.5 + R(rng, -0.06, 0.06), 0.5 + R(rng, -0.06, 0.06)]];
    for (let i = 1; i < n; i++) {
      const a = a0 + (i / (n - 1)) * Math.PI * 2;
      pts.push([clamp01(0.5 + Math.cos(a) * r), clamp01(0.5 + Math.sin(a) * r)]);
    }
    return pts;
  },
  cluster(rng, n) {
    const c = [[R(rng, 0.15, 0.4), R(rng, 0.15, 0.45)], [R(rng, 0.6, 0.85), R(rng, 0.55, 0.85)]];
    return Array.from({ length: n }, (_, i) => {
      const a = c[i % 2];
      return [clamp01(a[0] + R(rng, -0.22, 0.22)), clamp01(a[1] + R(rng, -0.22, 0.22))];
    });
  },
};
export const ARRANGEMENT_IDS = Object.keys(ARRANGEMENTS);

const clamp01 = (v) => Math.min(1, Math.max(0, v));

let idCounter = 0;
export function newPointId(rng) {
  idCounter = (idCounter + 1) % 1e6;
  return 'p' + Math.floor((rng ? rng() : Math.random()) * 1e9).toString(36) + idCounter.toString(36);
}

export function makePoint(rng, x, y, color) {
  return {
    id: newPointId(rng), x, y, color: normalizeHex(color) || '#888888',
    radius: +R(rng, 0.42, 0.85).toFixed(2), softness: +R(rng, 0.45, 0.9).toFixed(2),
    influence: +R(rng, 0.85, 1.2).toFixed(2), locked: false,
  };
}

/** Colours ordered dark -> light and laid along a random direction, so the big picture reads as one gradient. */
function assignColors(rng, positions, colors) {
  if (rng() < 0.35) return shuffle(rng, colors);
  const ang = R(rng, 0, Math.PI * 2), d = [Math.cos(ang), Math.sin(ang)];
  const byPos = positions.map((p, i) => [p[0] * d[0] + p[1] * d[1], i]).sort((a, b) => a[0] - b[0]);
  const byL = colors.slice().sort((a, b) => hexToOklch(a)[0] - hexToOklch(b)[0]);
  const out = new Array(positions.length);
  byPos.forEach(([, idx], k) => { out[idx] = byL[k]; });
  return out;
}

export function defaultShape() {
  return { scale: 1, blend: 0.65, stretchX: 1, stretchY: 1, rotation: 0, warp: 0.18, warpScale: 1.4, swirl: 0 };
}
export function defaultMotion() {
  return { mode: 'drift', duration: 5, intensity: 0.5, direction: 307, smoothness: 0.85, warpSpeed: 1 };
}
export function defaultFinish() {
  return { grain: 0.08, grainSize: 1, animatedGrain: true, vignette: 0.08, saturation: 1, contrast: 1, exposure: 0, hue: 0 };
}

function randomShape(rng) {
  const s = defaultShape();
  s.scale = +R(rng, 0.9, 1.3).toFixed(2);
  s.blend = +R(rng, 0.42, 0.85).toFixed(2);
  if (rng() < 0.45) {
    if (rng() < 0.5) s.stretchX = +R(rng, 1.15, 1.7).toFixed(2); else s.stretchY = +R(rng, 1.15, 1.7).toFixed(2);
    s.rotation = Math.round(R(rng, -90, 90));
  }
  s.warp = +R(rng, 0.08, 0.36).toFixed(2);
  s.warpScale = +R(rng, 0.8, 2.2).toFixed(2);
  s.swirl = rng() < 0.4 ? +R(rng, -1.4, 1.4).toFixed(2) : 0;
  return s;
}

export function randomMotionValues(rng, mode) {
  return {
    mode: mode || pick(rng, ['drift', 'orbit', 'breathe', 'flow', 'tide']),
    duration: pick(rng, [5, 6, 8]),
    intensity: +R(rng, 0.35, 0.7).toFixed(2),
    direction: Math.round(R(rng, 0, 359)),
    smoothness: +R(rng, 0.65, 0.95).toFixed(2),
    warpSpeed: +R(rng, 0.6, 1.5).toFixed(2),
  };
}

function randomFinish(rng) {
  const f = defaultFinish();
  f.grain = +R(rng, 0.04, 0.12).toFixed(2);
  f.vignette = +R(rng, 0, 0.16).toFixed(2);
  return f;
}

/**
 * A complete new gradient from a seed. `prev` keeps its name, format and locked points (position and colour).
 */
export function makeGradient(seed, prev = null) {
  const rng = mulberry32(seed);
  const locked = prev ? prev.points.filter((p) => p.locked) : [];
  let n = RI(rng, 4, 6);
  if (locked.length >= n) n = Math.min(MAX_POINTS, locked.length + 1);
  const free = n - locked.length;
  const arrangement = pick(rng, ARRANGEMENT_IDS);
  const palette = makePalette(rng, free);
  const pos = ARRANGEMENTS[arrangement](rng, free);
  const cols = assignColors(rng, pos, palette.colors);
  const points = [...locked.map((p) => ({ ...p })), ...pos.map((p, i) => makePoint(rng, +p[0].toFixed(4), +p[1].toFixed(4), cols[i]))];
  return {
    v: 1,
    name: prev ? prev.name : 'Untitled gradient',
    seed: seed >>> 0,
    paletteName: palette.name,
    format: prev ? { ...prev.format } : { ...FORMATS[0] },
    points,
    shape: randomShape(rng),
    motion: prev && prev.motion.mode === 'still' ? { ...prev.motion } : randomMotionValues(rng),
    finish: randomFinish(rng),
  };
}

/** New colours for every unlocked point; positions stay. */
export function randomizeColors(doc, seed) {
  const rng = mulberry32(seed);
  const free = doc.points.filter((p) => !p.locked);
  const palette = makePalette(rng, Math.max(1, free.length));
  const cols = assignColors(rng, free.map((p) => [p.x, p.y]), palette.colors);
  let k = 0;
  return {
    ...doc, paletteName: palette.name,
    points: doc.points.map((p) => (p.locked ? p : { ...p, color: cols[k++] })),
  };
}

/** Same colours, new arrangement (unlocked points only) and a slightly different shape. */
export function generateVariation(doc, seed) {
  const rng = mulberry32(seed);
  const free = doc.points.filter((p) => !p.locked);
  const pos = ARRANGEMENTS[pick(rng, ARRANGEMENT_IDS)](rng, free.length);
  const order = shuffle(rng, free.map((_, i) => i));
  let k = 0;
  const points = doc.points.map((p) => {
    if (p.locked) return p;
    const q = pos[order[k++]];
    return { ...p, x: +q[0].toFixed(4), y: +q[1].toFixed(4) };
  });
  const shape = { ...doc.shape, rotation: Math.round(R(rng, -90, 90)), warp: +R(rng, 0.08, 0.36).toFixed(2), swirl: rng() < 0.4 ? +R(rng, -1.4, 1.4).toFixed(2) : 0 };
  return { ...doc, points, shape };
}

export function randomizeMotion(doc, seed) {
  const rng = mulberry32(seed);
  const m = randomMotionValues(rng, doc.motion.mode);
  return { ...doc, motion: m };
}

/** A colour for a point added by double-click: a neighbour of the palette with a small twist. */
export function colorForNewPoint(doc, seed) {
  const rng = mulberry32(seed);
  const src = doc.points.length ? pick(rng, doc.points).color : '#7F5AF0';
  const [L, C, h] = hexToOklch(src);
  return oklchToHex(Math.min(0.95, Math.max(0.1, L + R(rng, -0.18, 0.18))), Math.max(0.04, C * R(rng, 0.8, 1.25)), wrapHue(h + R(rng, -40, 40)));
}

export const QUICK_COLORS = ['#F2A7C3', '#B69CF4', '#6EC6F5', '#F5C77E', '#9ED9A0', '#F28C8C', '#7189C9', '#E8D3B0',
  '#0B0E1A', '#FFFFFF'];

// ---- template pack ------------------------------------------------------------------------------------------
// [x, y, colour] per point, plus shape and motion tweaks. Picked by hand to cover the looks in the reel and beyond.
const T = (name, pts, shape = {}, motion = {}, finish = {}) => ({ name, pts, shape, motion, finish });
export const TEMPLATES = [
  T('Duotone Haze', [[0.08, 0.06, '#0B0E1A'], [0.25, 0.42, '#F2994A'], [0.9, 0.22, '#2A1205'], [0.14, 0.92, '#18A9F0'], [0.88, 0.86, '#1BC5C9']],
    { blend: 0.7, warp: 0.22 }, { mode: 'drift', direction: 307 }),
  T('Violet Dusk', [[0.05, 0.2, '#1A0526'], [0.12, 0.86, '#E39A4F'], [0.6, 0.4, '#E58FB0'], [0.86, 0.78, '#9E66F0'], [0.95, 0.06, '#6B3FD9']],
    { blend: 0.62, stretchY: 1.35, rotation: -25 }, { mode: 'flow' }),
  T('Midnight Arc', [[0.06, 0.04, '#02040F'], [0.55, 0.52, '#E8E21A'], [0.93, 0.88, '#3A6BFF'], [0.94, 0.05, '#5A6E8A'], [0.04, 0.78, '#0A0A12']],
    { blend: 0.48, stretchX: 1.7, rotation: -38, swirl: 0.9, warp: 0.12 }, { mode: 'orbit' }),
  T('Aurora', [[0.5, 0.95, '#04130F'], [0.2, 0.3, '#16E0A0'], [0.8, 0.25, '#5B2EE5'], [0.85, 0.75, '#0A3B5C'], [0.35, 0.6, '#B5FFE0']],
    { stretchX: 1.4, rotation: 15, warp: 0.32 }, { mode: 'tide', direction: 90 }),
  T('Peach Fuzz', [[0.1, 0.1, '#FFBE98'], [0.85, 0.2, '#FF8A65'], [0.5, 0.55, '#FFE3D3'], [0.15, 0.9, '#F6A6B2'], [0.9, 0.9, '#FFD59E']],
    { blend: 0.85 }, { mode: 'breathe' }, { grain: 0.06 }),
  T('Lagoon', [[0.1, 0.15, '#00A6A6'], [0.85, 0.1, '#003F5C'], [0.5, 0.5, '#7FE7DC'], [0.1, 0.85, '#1B6CA8'], [0.9, 0.9, '#F2F7F2']],
    {}, { mode: 'flow' }),
  T('Ember Bloom', [[0.5, 0.05, '#120404'], [0.2, 0.55, '#FF4D1A'], [0.8, 0.45, '#FFB347'], [0.5, 0.95, '#8A0F2E'], [0.55, 0.6, '#FFE0B2']],
    { blend: 0.55, swirl: -0.8 }, { mode: 'breathe' }),
  T('Lilac Mist', [[0.15, 0.15, '#E7D9FF'], [0.85, 0.25, '#B9A2FF'], [0.3, 0.7, '#F8E1F4'], [0.8, 0.85, '#8E7CF0'], [0.5, 0.45, '#FBF7FF']],
    { blend: 0.9 }, { mode: 'drift' }, { grain: 0.05 }),
  T('Citrus Pop', [[0.1, 0.1, '#FFE14D'], [0.9, 0.15, '#FF7A1A'], [0.2, 0.85, '#3DDC84'], [0.55, 0.5, '#FFF6C9'], [0.9, 0.85, '#FF4F79']],
    { blend: 0.6 }, { mode: 'orbit' }),
  T('Deep Sea', [[0.5, 0.02, '#010B1F'], [0.15, 0.5, '#0B3D91'], [0.75, 0.6, '#00C2FF'], [0.3, 0.95, '#072146'], [0.9, 0.9, '#3FE0D0']],
    { stretchY: 1.4, warp: 0.3 }, { mode: 'tide', direction: 270 }),
  T('Rose Quartz', [[0.1, 0.1, '#F7CAC9'], [0.9, 0.1, '#92A8D1'], [0.5, 0.5, '#F4E1E6'], [0.1, 0.9, '#C5B4E3'], [0.9, 0.9, '#FCE9DB']],
    { blend: 0.88 }, { mode: 'drift' }, { grain: 0.05 }),
  T('Solar Flare', [[0.05, 0.95, '#2B0A00'], [0.4, 0.55, '#FF6A00'], [0.75, 0.25, '#FFD000'], [0.95, 0.75, '#C2002F'], [0.2, 0.15, '#FF9E6D']],
    { swirl: 1.1, warp: 0.25 }, { mode: 'flow' }),
  T('Mint Fog', [[0.1, 0.1, '#E6FFF5'], [0.85, 0.2, '#9BE8CF'], [0.4, 0.6, '#5CC9B0'], [0.15, 0.9, '#D4F1FF'], [0.9, 0.85, '#A0B9FF']],
    { blend: 0.85 }, { mode: 'breathe' }, { grain: 0.05 }),
  T('Neon Night', [[0.5, 0.5, '#05010D'], [0.1, 0.15, '#FF2E97'], [0.9, 0.3, '#2EF2FF'], [0.25, 0.9, '#7A00FF'], [0.85, 0.92, '#120030']],
    { blend: 0.55, warp: 0.2 }, { mode: 'orbit' }, { grain: 0.1 }),
];

export function applyTemplate(tpl, prev, seed) {
  const rng = mulberry32(seed);
  const points = tpl.pts.map(([x, y, c]) => ({ ...makePoint(rng, x, y, c), radius: 0.65, softness: 0.7, influence: 1 }));
  return {
    v: 1,
    name: prev ? prev.name : 'Untitled gradient',
    seed: seed >>> 0,
    paletteName: tpl.name,
    format: prev ? { ...prev.format } : { ...FORMATS[0] },
    points,
    shape: { ...defaultShape(), ...tpl.shape },
    motion: { ...defaultMotion(), ...tpl.motion },
    finish: { ...defaultFinish(), ...tpl.finish },
  };
}

/** Repairs anything missing or out of range in a stored gradient (old Recent entries, hand-edited files). */
export function sanitizeDoc(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.points) || !d.points.length) return null;
  const num = (v, a, b, def) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : def);
  const sh = { ...defaultShape(), ...(d.shape || {}) }, mo = { ...defaultMotion(), ...(d.motion || {}) }, fi = { ...defaultFinish(), ...(d.finish || {}) };
  const fmt = d.format && d.format.w && d.format.h ? { ...d.format, w: num(d.format.w, 16, 4096, 900), h: num(d.format.h, 16, 4096, 1440) } : { ...FORMATS[0] };
  return {
    v: 1, name: String(d.name || 'Untitled gradient').slice(0, 80), seed: (d.seed >>> 0) || 1,
    paletteName: String(d.paletteName || 'Gradient').slice(0, 40), format: fmt,
    points: d.points.slice(0, MAX_POINTS).map((p) => ({
      id: String(p.id || newPointId()), x: num(p.x, -0.2, 1.2, 0.5), y: num(p.y, -0.2, 1.2, 0.5),
      color: normalizeHex(p.color) || '#888888', radius: num(p.radius, 0.05, 2, 0.6), softness: num(p.softness, 0, 1, 0.6),
      influence: num(p.influence, 0.05, 3, 1), locked: !!p.locked,
    })),
    shape: {
      scale: num(sh.scale, 0.3, 3, 1), blend: num(sh.blend, 0, 1, 0.65), stretchX: num(sh.stretchX, 0.3, 3, 1),
      stretchY: num(sh.stretchY, 0.3, 3, 1), rotation: num(sh.rotation, -180, 180, 0), warp: num(sh.warp, 0, 1, 0.18),
      warpScale: num(sh.warpScale, 0.2, 6, 1.4), swirl: num(sh.swirl, -3, 3, 0),
    },
    motion: {
      mode: ['still', 'drift', 'orbit', 'breathe', 'flow', 'tide'].includes(mo.mode) ? mo.mode : 'drift',
      duration: num(mo.duration, 1, 20, 5), intensity: num(mo.intensity, 0, 1, 0.5), direction: num(mo.direction, 0, 359, 0),
      smoothness: num(mo.smoothness, 0, 1, 0.85), warpSpeed: num(mo.warpSpeed, 0, 3, 1),
    },
    finish: {
      grain: num(fi.grain, 0, 0.5, 0.08), grainSize: num(fi.grainSize, 1, 4, 1), animatedGrain: fi.animatedGrain !== false,
      vignette: num(fi.vignette, 0, 1, 0), saturation: num(fi.saturation, 0, 2, 1), contrast: num(fi.contrast, 0.5, 1.5, 1),
      exposure: num(fi.exposure, -1, 1, 0), hue: num(fi.hue, -180, 180, 0),
    },
  };
}
