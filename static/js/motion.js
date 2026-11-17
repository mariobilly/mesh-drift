// Motion: where every colour point sits at loop phase t (0..1). Every mode is periodic in t, and every offset is
// zero at t = 0, so a paused canvas shows the points where you put them and exported videos loop seamlessly.

export const MODES = [
  { id: 'still', label: 'Still' },
  { id: 'drift', label: 'Drift' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'breathe', label: 'Breathe' },
  { id: 'flow', label: 'Flow' },
  { id: 'tide', label: 'Tide' },
];

const TAU = Math.PI * 2;

/** Stable per-point randomness from the point id (phase, turning direction, harmonic). */
export function pointHash(id, salt = 0) {
  let h = 2166136261 ^ salt;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Half extents of the canvas in "short-side" units: the short side is always 1 long, so circles stay round. */
export function halfExtents(w, h) {
  const m = Math.min(w, h);
  return [(0.5 * w) / m, (0.5 * h) / m];
}

/** uv (0..1, top-left origin) -> centred short-side units, and back. */
export const uvToS = (x, y, half) => [(x - 0.5) * 2 * half[0], (y - 0.5) * 2 * half[1]];
export const sToUv = (sx, sy, half) => [sx / (2 * half[0]) + 0.5, sy / (2 * half[1]) + 0.5];

// Smoothness 1 is a pure sine; lower values add a second harmonic for a livelier, less even rhythm.
function wave(x, smooth) {
  return smooth * Math.sin(x) + (1 - smooth) * (0.78 * Math.sin(x) + 0.42 * Math.sin(2 * x + 1.3));
}

function rawOffset(mode, p, i, tau, A, dir, smooth, centroid) {
  const ph = pointHash(p.id, 1) * TAU;
  const sgn = pointHash(p.id, 2) < 0.5 ? -1 : 1;
  const m = pointHash(p.id, 3) < 0.65 ? 1 : 2;
  const perp = [-dir[1], dir[0]];
  switch (mode) {
    case 'drift': {
      const a = A * 0.42 * wave(tau + ph, smooth), b = A * 0.16 * wave(m * tau + ph * 1.7, smooth);
      return [dir[0] * a + perp[0] * b, dir[1] * a + perp[1] * b];
    }
    case 'orbit': {
      const r = A * 0.24, ang = sgn * m * tau + ph;
      const e = 0.85 + 0.15 * smooth;
      return [r * Math.cos(ang), r * Math.sin(ang) * e];
    }
    case 'breathe': {
      const k = A * 0.45 * wave(tau + ph * 0.25, smooth);
      return [(p.sx - centroid[0]) * k, (p.sy - centroid[1]) * k];
    }
    case 'flow': {
      const r = A * 0.22;
      return [r * Math.sin(tau + ph) + r * 0.5 * Math.sin(m * tau + ph * 2), r * Math.cos(tau + ph * 1.3)];
    }
    case 'tide': {
      const proj = p.sx * dir[0] + p.sy * dir[1];
      const a = A * 0.42 * wave(tau - proj * 3.2, smooth), b = A * 0.14 * wave(2 * tau - proj * 3.2, smooth);
      return [perp[0] * a + dir[0] * b, perp[1] * a + dir[1] * b];
    }
    default:
      return [0, 0];
  }
}

/**
 * Animated state at loop phase t.
 * Returns point positions in short-side units plus the global scale and the noise-warp phase for the shader.
 */
export function animate(doc, t, half) {
  const mo = doc.motion, mode = mo.mode;
  const tau = TAU * (((t % 1) + 1) % 1);
  const A = mode === 'still' ? 0 : mo.intensity;
  const th = (mo.direction * Math.PI) / 180, dir = [Math.cos(th), Math.sin(th)];
  const smooth = mo.smoothness;
  const pts = doc.points.map((p) => {
    const [sx, sy] = uvToS(p.x, p.y, half);
    return { id: p.id, sx, sy };
  });
  const centroid = pts.length ? [pts.reduce((a, p) => a + p.sx, 0) / pts.length, pts.reduce((a, p) => a + p.sy, 0) / pts.length] : [0, 0];
  const pos = pts.map((p, i) => {
    if (A === 0) return [p.sx, p.sy];
    const o = rawOffset(mode, p, i, tau, A, dir, smooth, centroid);
    const o0 = rawOffset(mode, p, i, 0, A, dir, smooth, centroid);
    return [p.sx + o[0] - o0[0], p.sy + o[1] - o0[1]];
  });

  // Global extras: Breathe pulses the size of every colour; every mode stirs the noise warp a little, Flow a lot.
  let scaleMul = 1, warpMul = 1, wr = 0;
  if (mode === 'breathe') scaleMul = 1 + 0.22 * A * Math.sin(tau);
  if (mode === 'flow') { wr = 0.9 * mo.warpSpeed; warpMul = 1 + 0.8 * A; } else if (A > 0) wr = 0.3 * A * mo.warpSpeed;
  const warpPhase = [wr * (Math.cos(tau) - 1), wr * Math.sin(tau)];
  return { pos, scaleMul, warpMul, warpPhase };
}

/** Where to draw point i's handle (uv) at phase t, and the base position that puts it under the cursor. */
export function handleUv(doc, i, t, half) {
  const a = animate(doc, t, half);
  return sToUv(a.pos[i][0], a.pos[i][1], half);
}

export function baseForHandle(doc, i, t, half, uvX, uvY) {
  const a = animate(doc, t, half);
  const [bx, by] = uvToS(doc.points[i].x, doc.points[i].y, half);
  const [hx, hy] = uvToS(uvX, uvY, half);
  return sToUv(hx - (a.pos[i][0] - bx), hy - (a.pos[i][1] - by), half);
}
