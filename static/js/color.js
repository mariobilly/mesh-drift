// Colour maths: hex <-> sRGB <-> linear <-> OKLab / OKLCH, and HSV for the picker.
// Gradients blend in OKLab, so mixes stay vivid instead of turning muddy grey.

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

export function rgbToHex([r, g, b]) {
  const to = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
  return ('#' + to(r) + to(g) + to(b)).toUpperCase();
}

export function normalizeHex(hex) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : null;
}

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const srgbToLinear = (rgb) => rgb.map(toLin);
export const linearToSrgb = (rgb) => rgb.map(toGam);

export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const hexToOklab = (hex) => linearToOklab(srgbToLinear(hexToRgb(hex) || [0, 0, 0]));

export function oklabToHex(lab) {
  return rgbToHex(linearToSrgb(oklabToLinear(lab)));
}

const inGamut = (lin) => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH (L 0..1, C 0..0.37, h degrees) -> hex, lowering chroma until the colour fits in sRGB. */
export function oklchToHex(L, C, h) {
  const rad = (h * Math.PI) / 180;
  let lo = 0, hi = Math.max(0, C);
  const lab = (c) => [clamp(L), c * Math.cos(rad), c * Math.sin(rad)];
  if (inGamut(oklabToLinear(lab(hi)))) return oklabToHex(lab(hi));
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(lab(mid)))) lo = mid; else hi = mid;
  }
  return oklabToHex(lab(lo));
}

export function hexToOklch(hex) {
  const [L, a, b] = hexToOklab(hex);
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

// ---- HSV (the picker's square + hue strip) ----
export function rgbToHsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb([h, s, v]) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Perceived lightness 0..1, used to pick a readable ring colour for a point handle. */
export const lightness = (hex) => hexToOklab(hex)[0];
