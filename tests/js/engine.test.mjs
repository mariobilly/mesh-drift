// Engine unit tests (no browser): node --test tests/js
import test from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../../static/js/color.js';
import * as G from '../../static/js/generate.js';
import * as M from '../../static/js/motion.js';
import * as Z from '../../static/js/sizes.js';
import { History, Recent } from '../../static/js/history.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('colour: hex <-> OKLab round trip stays within one 8-bit step', () => {
  for (const hex of ['#000000', '#FFFFFF', '#FF4A1F', '#18A9F0', '#7F5AF0', '#0B0E1A', '#E8E21A']) {
    assert.equal(C.oklabToHex(C.hexToOklab(hex)), hex);
  }
  assert.equal(C.normalizeHex('abc'), '#AABBCC');
  assert.equal(C.normalizeHex('#12345'), null);
});

test('colour: OKLCH -> hex always lands inside sRGB, even for impossible chroma', () => {
  for (let h = 0; h < 360; h += 15) {
    for (const L of [0.1, 0.5, 0.9]) {
      const hex = C.oklchToHex(L, 0.4, h);
      assert.match(hex, /^#[0-9A-F]{6}$/);
    }
  }
});

test('colour: HSV round trip', () => {
  for (const hex of ['#FF0000', '#00FF80', '#123456', '#FFFFFF', '#808080']) {
    assert.equal(C.rgbToHex(C.hsvToRgb(C.rgbToHsv(C.hexToRgb(hex)))), hex);
  }
});

test('generate: the same seed gives the same gradient, different seeds differ', () => {
  const a = G.makeGradient(12345), b = G.makeGradient(12345), c = G.makeGradient(54321);
  const strip = (d) => JSON.stringify({ ...d, points: d.points.map(({ id, ...p }) => p) });
  assert.equal(strip(a), strip(b));
  assert.notEqual(strip(a), strip(c));
});

test('generate: 500 random gradients are all valid and varied', () => {
  const palettes = new Set(), modes = new Set();
  for (let s = 1; s <= 500; s++) {
    const d = G.makeGradient(s * 2654435761 >>> 0);
    assert.ok(d.points.length >= 4 && d.points.length <= 6, 'point count');
    for (const p of d.points) {
      assert.match(p.color, /^#[0-9A-F]{6}$/);
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, 'position inside the canvas');
      assert.ok(p.radius > 0 && p.softness >= 0 && p.softness <= 1 && p.influence > 0);
    }
    assert.deepEqual(G.sanitizeDoc(d), d, 'a generated gradient needs no repair');
    palettes.add(d.paletteName.split(' ')[0]);
    modes.add(d.motion.mode);
  }
  assert.ok(palettes.size >= 20, `palette families: ${palettes.size}`);
  assert.deepEqual([...modes].sort(), ['breathe', 'drift', 'flow', 'orbit', 'tide']);
});

test('generate: locked points survive New Gradient, Randomize colors and Generate variation', () => {
  let d = G.makeGradient(7);
  d.points[1] = { ...d.points[1], locked: true, color: '#123456', x: 0.31, y: 0.62 };
  const locked = d.points[1];
  for (let s = 0; s < 40; s++) {
    const n = G.makeGradient(1000 + s, d);
    assert.ok(n.points.some((p) => p.id === locked.id && p.color === '#123456' && p.x === 0.31 && p.y === 0.62));
    const r = G.randomizeColors(d, 2000 + s);
    assert.equal(r.points[1].color, '#123456');
    const v = G.generateVariation(d, 3000 + s);
    assert.equal(v.points[1].x, 0.31);
    assert.equal(v.points[1].y, 0.62);
    assert.deepEqual(v.points.map((p) => p.color), d.points.map((p) => p.color), 'variation keeps colours');
  }
});

test('generate: New Gradient keeps the name and canvas format', () => {
  const d = { ...G.makeGradient(1), name: 'Client hero', format: { id: 'wide', label: 'Widescreen', w: 1920, h: 1080 } };
  const n = G.makeGradient(2, d);
  assert.equal(n.name, 'Client hero');
  assert.deepEqual(n.format, d.format);
});

test('templates: all 14 build valid gradients', () => {
  assert.equal(G.TEMPLATES.length, 14);
  for (const t of G.TEMPLATES) {
    const d = G.applyTemplate(t, null, 99);
    assert.deepEqual(G.sanitizeDoc(d), d, t.name);
    assert.equal(d.paletteName, t.name);
  }
});

test('sanitizeDoc repairs broken input and rejects junk', () => {
  assert.equal(G.sanitizeDoc(null), null);
  assert.equal(G.sanitizeDoc({ points: [] }), null);
  const d = G.sanitizeDoc({ points: [{ x: 9, y: -9, color: 'nope', radius: 'x' }, { x: 0.5, y: 0.5, color: '#fff' }], motion: { mode: 'warp' } });
  assert.equal(d.points[0].x, 1.2);
  assert.equal(d.points[0].y, -0.2);
  assert.equal(d.points[0].color, '#888888');
  assert.equal(d.points[1].color, '#FFFFFF');
  assert.equal(d.motion.mode, 'drift');
});

test('motion: every mode loops (t=0 equals t=1) and rests on the base positions at t=0', () => {
  const half = M.halfExtents(900, 1440);
  for (const mode of M.MODES.map((m) => m.id)) {
    const d = { ...G.makeGradient(42), motion: { ...G.defaultMotion(), mode, intensity: 0.8, smoothness: 0.4 } };
    const a0 = M.animate(d, 0, half), a1 = M.animate(d, 1, half), a2 = M.animate(d, 2, half);
    d.points.forEach((p, i) => {
      const [bx, by] = M.uvToS(p.x, p.y, half);
      assert.ok(close(a0.pos[i][0], bx) && close(a0.pos[i][1], by), `${mode} rest`);
      assert.ok(close(a1.pos[i][0], a0.pos[i][0]) && close(a1.pos[i][1], a0.pos[i][1]), `${mode} loop`);
      assert.ok(close(a2.pos[i][0], a0.pos[i][0]), `${mode} second loop`);
    });
    assert.ok(close(a1.scaleMul, a0.scaleMul) && close(a1.warpPhase[0], a0.warpPhase[0]) && close(a1.warpPhase[1], a0.warpPhase[1]), `${mode} globals loop`);
  }
});

test('motion: Still never moves, the other modes do', () => {
  const half = M.halfExtents(1080, 1080);
  for (const mode of M.MODES.map((m) => m.id)) {
    const d = { ...G.makeGradient(5), motion: { ...G.defaultMotion(), mode, intensity: 0.7 } };
    let travel = 0;
    for (let k = 1; k < 20; k++) {
      const a = M.animate(d, k / 20, half), b = M.animate(d, 0, half);
      travel += a.pos.reduce((s, p, i) => s + Math.hypot(p[0] - b.pos[i][0], p[1] - b.pos[i][1]), 0);
      travel += Math.abs(a.warpPhase[0]) + Math.abs(a.warpPhase[1]);
    }
    if (mode === 'still') assert.equal(travel, 0);
    else assert.ok(travel > 0.5, `${mode} moves (${travel.toFixed(2)})`);
  }
});

test('motion: intensity 0 is still, and a dragged handle lands under the cursor', () => {
  const half = M.halfExtents(900, 1440);
  const d = { ...G.makeGradient(9), motion: { ...G.defaultMotion(), mode: 'orbit', intensity: 0 } };
  const a = M.animate(d, 0.37, half);
  d.points.forEach((p, i) => assert.ok(close(a.pos[i][0], M.uvToS(p.x, p.y, half)[0])));
  const m = { ...d, motion: { ...d.motion, intensity: 0.9 } };
  const [bx, by] = M.baseForHandle(m, 2, 0.37, half, 0.25, 0.75);
  const moved = { ...m, points: m.points.map((p, i) => (i === 2 ? { ...p, x: bx, y: by } : p)) };
  const [u, v] = M.handleUv(moved, 2, 0.37, half);
  assert.ok(close(u, 0.25, 1e-9) && close(v, 0.75, 1e-9));
});

test('sizes: multipliers stop at 4096 px, video sizes are even and keep the shape', () => {
  assert.deepEqual(Z.imageSize(900, 1440, 2), { w: 1800, h: 2880, ok: true });
  assert.equal(Z.imageSize(900, 1440, 4).ok, false, '4x of 900x1440 passes 4096');
  assert.equal(Z.imageSize(1000, 1000, 4).ok, true);
  for (const f of Z.FORMATS) {
    for (const v of Z.VIDEO_SIZES) {
      const s = Z.videoSize(f.w, f.h, v.id);
      assert.equal(s.w % 2, 0);
      assert.equal(s.h % 2, 0);
      assert.ok(Math.max(s.w, s.h) <= 4096);
      assert.ok(Math.abs(s.w / s.h - f.w / f.h) < 0.01, `${f.id} ${v.id} keeps aspect`);
    }
  }
  assert.deepEqual(Z.videoSize(1440, 900, 'hd'), { w: 1920, h: 1200 });
  assert.deepEqual(Z.videoSize(1920, 1080, 'hd'), { w: 1920, h: 1080 });
});

test('sizes: loops fit the export length; file names', () => {
  assert.equal(Z.loopCount(10, 5), 2);
  assert.equal(Z.loopCount(3, 5), 1);
  assert.equal(Z.loopCount(10, 3), 3);
  const d = { name: 'Untitled gradient', paletteName: 'Duotone Haze' };
  assert.equal(Z.fileStem(d, 900, 1440), 'Duotone Haze 900x1440');
  assert.equal(Z.fileStem({ ...d, name: 'Hero BG' }, 1920, 1080, '30fps 5s'), 'Hero BG 1920x1080 30fps 5s');
});

test('history: undo / redo walk back and forth; a new change clears redo', () => {
  const h = new History(3);
  let doc = { v: 1 };
  for (let v = 2; v <= 5; v++) { h.record(doc); doc = { v }; }
  assert.equal(h.past.length, 3, 'limit');
  doc = h.undo(doc); assert.equal(doc.v, 4);
  doc = h.undo(doc); assert.equal(doc.v, 3);
  doc = h.redo(doc); assert.equal(doc.v, 4);
  h.record(doc); doc = { v: 9 };
  assert.equal(h.canRedo, false);
  h.record(doc); h.record(doc);
  assert.equal(h.past.filter((s) => s === JSON.stringify({ v: 9 })).length, 1, 'no duplicate snapshots');
});

test('recent: newest first, no duplicates, survives broken or full storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const r = new Recent(storage, 'k', 3);
  const a = G.makeGradient(1), b = G.makeGradient(2), c = G.makeGradient(3), d = G.makeGradient(4);
  r.add(a); r.add(b); r.add(a);
  assert.deepEqual(r.items.map((x) => x.doc.seed), [1, 2]);
  r.add(c); r.add(d);
  assert.deepEqual(r.items.map((x) => x.doc.seed), [4, 3, 1]);
  assert.equal(new Recent(storage, 'k').items.length, 3, 'reloads from storage');
  mem.set('k', '{not json');
  assert.deepEqual(new Recent(storage, 'k').items, []);
  let calls = 0;
  const full = { getItem: () => null, setItem: (k, v) => { calls++; if (JSON.parse(v).length > 1) throw new Error('quota'); } };
  const rf = new Recent(full, 'k', 5);
  rf.add(a); rf.add(b); rf.add(c);
  assert.equal(rf.items.length, 1, 'drops the oldest until it fits');
  assert.ok(calls > 3);
});
