// Mesh Drift: the window. Wires the canvas, the colour points, the four adjustment tabs, history, Recent,
// templates and export to the engine modules.

import {
  makeGradient, randomSeed, seedLabel, randomizeColors, generateVariation, randomizeMotion, colorForNewPoint,
  makePoint, mulberry32, QUICK_COLORS, TEMPLATES, applyTemplate, sanitizeDoc, MAX_POINTS, defaultShape,
  defaultMotion, defaultFinish,
} from './generate.js';
import { MODES, halfExtents, handleUv, baseForHandle } from './motion.js';
import { GradientRenderer, thumbnail } from './renderer.js';
import { History, Recent } from './history.js';
import { FORMATS, VIDEO_SIZES, imageSize, videoSize, fileStem, clampDim, loopCount, MAX_EDGE } from './sizes.js';
import { exportImage, exportVideo } from './exporter.js';
import { ColorPicker } from './picker.js';
import { normalizeHex } from './color.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad2 = (n) => String(n).padStart(2, '0');

// ---- icons (inline SVG, stroke style) ---------------------------------------------------------------------
const ICONS = {
  logo: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  format: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5z"/><path d="m16 7 5 5-5 5z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6"/><path d="M12 17h.01"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="m3 3 18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  shuffle: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  wand: '<path d="m3 21 12-12M14 4l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM19 11l.7-1.3L21 9l-1.3-.7L19 7l-.7 1.3L17 9l1.3.7z"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
function paintIcons(root = document) {
  $$('i[data-i]', root).forEach((el) => {
    const wrap = document.createElement('span');
    wrap.innerHTML = icon(el.dataset.i);
    const svg = wrap.firstChild;
    if (el.classList.contains('chev')) svg.classList.add('chev');
    el.replaceWith(svg);
  });
}

// ---- storage that never throws ----------------------------------------------------------------------------
const store = (() => {
  try {
    localStorage.setItem('__gs', '1');
    localStorage.removeItem('__gs');
    return localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
})();
const KEY_SESSION = 'mesh-drift.session', KEY_PREFS = 'mesh-drift.prefs';
const readJSON = (k) => { try { return JSON.parse(store.getItem(k) || 'null'); } catch { return null; } };

// ---- state --------------------------------------------------------------------------------------------------
const S = {
  doc: null, previous: null, selected: 0, playing: true, t: 0, frame: 0, grainClock: 0, editPoints: true,
  server: null, dirty: true, lastTs: 0, exporting: false, sliding: false, handleCount: -1,
};
const hist = new History();
const recent = new Recent(store);
let renderer = null;

const half = () => halfExtents(S.doc.format.w, S.doc.format.h);
const markDirty = () => { S.dirty = true; };

function setDoc(next, { record = true } = {}) {
  if (!next) return;
  if (record) hist.record(S.doc);
  S.doc = next;
  S.selected = Math.min(S.selected, S.doc.points.length - 1);
  onDocChanged();
}

let fittedFormat = '';
function onDocChanged() {
  markDirty();
  const fk = `${S.doc.format.w}x${S.doc.format.h}`;
  if (fk !== fittedFormat) { fittedFormat = fk; fitFrame(); }
  syncPanel();
  scheduleSave();
}

function patch(group, key, value) {
  S.doc = { ...S.doc, [group]: { ...S.doc[group], [key]: value } };
}
function patchPoint(i, obj) {
  const pts = S.doc.points.slice();
  pts[i] = { ...pts[i], ...obj };
  S.doc = { ...S.doc, points: pts };
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { store.setItem(KEY_SESSION, JSON.stringify(S.doc)); } catch { /* storage full */ }
    try { store.setItem(KEY_PREFS, JSON.stringify({ editPoints: S.editPoints })); } catch { /* ignore */ }
  }, 250);
}

function safeThumb(doc) {
  try { return thumbnail(doc, 132); } catch { return ''; }
}

// ---- toast ------------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, path = null) {
  $('#toastMsg').textContent = msg;
  const btn = $('#toastBtn');
  btn.hidden = !path;
  btn.onclick = path ? () => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) }).catch(() => {}) : null;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, path ? 9000 : 3200);
}

// ---- sliders --------------------------------------------------------------------------------------------
const f2 = (v) => (+v).toFixed(2);
const deg = (v) => `${Math.round(v)}°`;
const SL = {
  slPoint: ['point', [['radius', 'Radius', 0.1, 2, 0.01, f2, 0.65], ['softness', 'Softness', 0, 1, 0.01, f2, 0.7], ['influence', 'Influence', 0.1, 3, 0.01, f2, 1]]],
  slShape: ['shape', [['scale', 'Scale', 0.3, 3, 0.01, f2], ['blend', 'Blend', 0, 1, 0.01, f2], ['stretchX', 'Stretch X', 0.3, 3, 0.01, f2],
    ['stretchY', 'Stretch Y', 0.3, 3, 0.01, f2], ['rotation', 'Rotation', -180, 180, 1, deg]]],
  slShapeAdv: ['shape', [['warp', 'Warp', 0, 1, 0.01, f2], ['warpScale', 'Warp detail', 0.2, 6, 0.01, f2], ['swirl', 'Swirl', -3, 3, 0.01, f2]]],
  slMotion: ['motion', [['duration', 'Duration', 1, 20, 0.5, (v) => `${f2(v)}s`], ['intensity', 'Intensity', 0, 1, 0.01, f2],
    ['direction', 'Direction', 0, 359, 1, deg], ['smoothness', 'Smoothness', 0, 1, 0.01, f2], ['warpSpeed', 'Warp speed', 0, 3, 0.01, f2]]],
  slFinishTex: ['finish', [['grain', 'Grain', 0, 0.5, 0.005, f2], ['grainSize', 'Grain size', 1, 4, 0.1, f2]]],
  slFinishTone: ['finish', [['exposure', 'Exposure', -1, 1, 0.01, (v) => (v > 0 ? '+' : '') + f2(v)], ['contrast', 'Contrast', 0.5, 1.5, 0.01, f2],
    ['saturation', 'Saturation', 0, 2, 0.01, f2], ['hue', 'Hue shift', -180, 180, 1, deg]]],
  slFinishVig: ['finish', [['vignette', 'Vignette', 0, 1, 0.01, f2]]],
};
const DEFAULTS = { shape: defaultShape(), motion: defaultMotion(), finish: defaultFinish() };
const sliders = []; // { group, key, input, val, fmt }

function buildSliders() {
  for (const [hostId, [group, list]] of Object.entries(SL)) {
    const host = document.getElementById(hostId);
    for (const [key, label, min, max, step, fmt, def] of list) {
      const wrap = document.createElement('div');
      wrap.className = 'sl';
      wrap.innerHTML = `<div class="sl-top"><span class="sl-label" title="Double-click to reset">${label}</span><span class="sl-val"></span></div>
        <input type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}">`;
      const input = $('input', wrap), val = $('.sl-val', wrap);
      const s = { group, key, input, val, fmt, def: def ?? DEFAULTS[group]?.[key] };
      sliders.push(s);
      input.dataset.key = `${group}.${key}`;
      input.addEventListener('input', () => {
        if (!S.sliding) { hist.record(S.doc); S.sliding = true; }
        applySlider(s, +input.value);
      });
      input.addEventListener('change', () => { S.sliding = false; syncPanel(); scheduleSave(); });
      $('.sl-label', wrap).addEventListener('dblclick', () => {
        if (s.def === undefined) return;
        hist.record(S.doc);
        applySlider(s, s.def);
        syncPanel();
        scheduleSave();
      });
      host.appendChild(wrap);
    }
  }
}

function applySlider(s, v) {
  if (s.group === 'point') {
    if (!S.doc.points[S.selected]) return;
    patchPoint(S.selected, { [s.key]: v });
  } else {
    patch(s.group, s.key, v);
  }
  paintSlider(s, v);
  markDirty();
  if (s.group === 'motion') updateMeta();
}

function paintSlider(s, v) {
  const min = +s.input.min, max = +s.input.max;
  if (document.activeElement !== s.input || !S.sliding) s.input.value = v;
  s.input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  s.val.textContent = s.fmt(v);
}

// ---- panel sync ------------------------------------------------------------------------------------------
function syncPanel() {
  const d = S.doc;
  $('#docName').value = d.name;
  $('#paletteName').textContent = d.paletteName;
  $('#ptCount').textContent = `${pad2(d.points.length)} POINTS`;
  $('#btnUndo').disabled = !hist.canUndo;
  $('#btnRedo').disabled = !hist.canRedo;
  $('#btnPrev').disabled = !S.previous;
  const f = FORMATS.find((x) => x.id === d.format.id);
  $('#fmtLabel').textContent = f ? `${f.label}` : 'Custom';
  $('#liveSize').textContent = `${d.format.w} × ${d.format.h}`;
  for (const s of sliders) {
    const src = s.group === 'point' ? d.points[S.selected] : d[s.group];
    if (src) paintSlider(s, src[s.key]);
  }
  $$('#modes .mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === d.motion.mode));
  $('#animGrain').checked = d.finish.animatedGrain;
  renderPointList();
  renderSelected();
  renderHandles();
  updateMeta();
  updatePlay();
  $$('#menuFormat .item').forEach((b) => b.classList.toggle('on', b.dataset.id === d.format.id));
}

function updateMeta() {
  $('#meta').textContent = `${S.doc.points.length} COLOR POINTS · SEED ${seedLabel(S.doc.seed)}`;
}

function renderPointList() {
  const host = $('#ptList');
  host.innerHTML = '';
  S.doc.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pt-row' + (i === S.selected ? ' sel' : '');
    row.dataset.i = i;
    row.innerHTML = `<i class="sw" style="background:${p.color}"></i><span>Point ${pad2(i + 1)}</span><span class="hx">${p.color}</span>
      <button class="lk${p.locked ? ' on' : ''}" title="${p.locked ? 'Unlock' : 'Lock'}" aria-label="${p.locked ? 'Unlock' : 'Lock'} point ${i + 1}">${icon(p.locked ? 'lock' : 'unlock')}</button>`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.lk')) { toggleLock(i); return; }
      select(i);
    });
    host.appendChild(row);
  });
  $('#btnRandColors').disabled = S.doc.points.every((p) => p.locked);
}

let picker = null;
function renderSelected() {
  const p = S.doc.points[S.selected];
  $('#selSec').hidden = !p;
  if (!p) return;
  $('#selIdx').textContent = `${pad2(S.selected + 1)} / ${pad2(S.doc.points.length)}`;
  $('#selSwatch').style.background = p.color;
  if (document.activeElement !== $('#selHex')) $('#selHex').value = p.color;
  const lock = $('#selLock');
  lock.classList.toggle('on', p.locked);
  lock.innerHTML = icon(p.locked ? 'lock' : 'unlock');
  $('#selDelete').disabled = S.doc.points.length <= 2;
  if (picker && !picker.dragging && !$('#pickerBox').hidden) picker.set(p.color);
}

function select(i) {
  if (i < 0 || i >= S.doc.points.length) return;
  S.selected = i;
  renderPointList();
  renderSelected();
  for (const s of sliders) if (s.group === 'point') paintSlider(s, S.doc.points[i][s.key]);
  $$('.handle').forEach((h, k) => h.classList.toggle('sel', k === i));
}

function toggleLock(i = S.selected) {
  const p = S.doc.points[i];
  if (!p) return;
  hist.record(S.doc);
  patchPoint(i, { locked: !p.locked });
  onDocChanged();
}

function setPointColor(hex, { record = true } = {}) {
  const c = normalizeHex(hex);
  if (!c || !S.doc.points[S.selected]) return;
  if (record) hist.record(S.doc);
  patchPoint(S.selected, { color: c });
  markDirty();
  // cheap refresh while dragging in the picker
  const row = $(`.pt-row[data-i="${S.selected}"]`);
  if (row) { $('.sw', row).style.background = c; $('.hx', row).textContent = c; }
  $('#selSwatch').style.background = c;
  if (document.activeElement !== $('#selHex')) $('#selHex').value = c;
  const h = $$('.handle')[S.selected];
  if (h) $('i', h).style.background = c;
}

function deletePoint(i = S.selected) {
  if (S.doc.points.length <= 2) { toast('A gradient needs at least two colour points.'); return; }
  const pts = S.doc.points.filter((_, k) => k !== i);
  S.selected = Math.max(0, Math.min(i, pts.length - 1));
  setDoc({ ...S.doc, points: pts });
}

// ---- canvas, handles, interaction ---------------------------------------------------------------------------
function fitFrame() {
  const stage = $('#stage'), frame = $('#frame');
  const r = stage.getBoundingClientRect();
  const padX = Math.min(64, r.width * 0.07), padY = Math.min(48, r.height * 0.06);
  const aw = Math.max(40, r.width - padX * 2), ah = Math.max(40, r.height - padY * 2);
  const { w, h } = S.doc.format;
  const s = Math.min(aw / w, ah / h);
  const cw = Math.round(w * s), ch = Math.round(h * s);
  Object.assign(frame.style, { width: `${cw}px`, height: `${ch}px`, left: `${Math.round((r.width - cw) / 2)}px`, top: `${Math.round((r.height - ch) / 2)}px` });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = $('#view');
  let bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
  const cap = 2400 / Math.max(bw, bh);
  if (cap < 1) { bw = Math.round(bw * cap); bh = Math.round(bh * cap); }
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = Math.max(1, bw); canvas.height = Math.max(1, bh); }
  markDirty();
}

function renderHandles() {
  const host = $('#handles');
  if (S.handleCount !== S.doc.points.length) {
    host.innerHTML = '';
    S.doc.points.forEach((_, i) => {
      const h = document.createElement('div');
      h.className = 'handle';
      h.dataset.i = i;
      h.innerHTML = '<i></i>';
      h.addEventListener('pointerdown', (e) => startDrag(e, +h.dataset.i));
      h.addEventListener('dblclick', (e) => e.stopPropagation());
      host.appendChild(h);
    });
    S.handleCount = S.doc.points.length;
  }
  $$('.handle', host).forEach((h, i) => {
    const p = S.doc.points[i];
    $('i', h).style.background = p.color;
    h.classList.toggle('sel', i === S.selected);
    h.classList.toggle('locked', p.locked);
    h.title = `Point ${pad2(i + 1)} · ${p.color}${p.locked ? ' · locked' : ''}`;
  });
  $('#frame').classList.toggle('noedit', !S.editPoints);
  placeHandles();
}

function placeHandles() {
  if (!S.editPoints) return;
  const frame = $('#frame'), W = frame.clientWidth, H = frame.clientHeight, hx = half();
  $$('.handle', $('#handles')).forEach((h, i) => {
    if (!S.doc.points[i]) return;
    const [u, v] = handleUv(S.doc, i, S.t, hx);
    h.style.transform = `translate(${(u * W).toFixed(1)}px, ${(v * H).toFixed(1)}px)`;
    h.style.left = '0px';
    h.style.top = '0px';
  });
}

function frameUv(e) {
  const r = $('#frame').getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

let drag = null;
function startDrag(e, i) {
  if (!S.editPoints || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  select(i);
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  drag = { i, moved: false };
  const move = (ev) => {
    const [u, v] = frameUv(ev);
    const [bx, by] = baseForHandle(S.doc, i, S.t, half(), Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
    if (!drag.moved) { hist.record(S.doc); drag.moved = true; }
    patchPoint(i, { x: +Math.min(1.2, Math.max(-0.2, bx)).toFixed(4), y: +Math.min(1.2, Math.max(-0.2, by)).toFixed(4) });
    markDirty();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (drag && drag.moved) { $('#btnUndo').disabled = false; scheduleSave(); }
    drag = null;
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function addPointAt(u, v) {
  if (S.doc.points.length >= MAX_POINTS) { toast(`Up to ${MAX_POINTS} colour points.`); return; }
  const seed = randomSeed();
  const rng = mulberry32(seed);
  const p = makePoint(rng, u, v, colorForNewPoint(S.doc, seed));
  p.radius = 0.5;
  const next = { ...S.doc, points: [...S.doc.points, p] };
  const i = next.points.length - 1;
  const [bx, by] = baseForHandle(next, i, S.t, halfExtents(next.format.w, next.format.h), u, v);
  next.points[i] = { ...p, x: +bx.toFixed(4), y: +by.toFixed(4) };
  S.selected = i;
  setDoc(next);
}

// ---- loop ---------------------------------------------------------------------------------------------------
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = S.lastTs ? Math.min(0.1, (ts - S.lastTs) / 1000) : 0;
  S.lastTs = ts;
  if (!renderer || S.exporting) return;
  if (S.playing) {
    if (S.doc.motion.mode !== 'still') { S.t = (S.t + dt / S.doc.motion.duration) % 1; S.dirty = true; }
    if (S.doc.finish.animatedGrain && S.doc.finish.grain > 0) {
      S.grainClock += dt;
      if (S.grainClock >= 1 / 24) { S.grainClock = 0; S.frame++; S.dirty = true; }
    }
  }
  if (S.dirty) {
    S.dirty = false;
    renderer.render(S.doc, S.t, { frame: S.frame });
    placeHandles();
  }
}

function updatePlay() {
  const b = $('#btnPlay');
  b.innerHTML = `${icon(S.playing ? 'pause' : 'play')}<span>${S.playing ? 'Pause' : 'Play'}</span>`;
  $('.live').classList.toggle('playing', S.playing);
}
function togglePlay(force) {
  S.playing = typeof force === 'boolean' ? force : !S.playing;
  updatePlay();
  markDirty();
}

// ---- gradient-level actions ---------------------------------------------------------------------------------
function newGradient(seed = randomSeed()) {
  const cur = S.doc;
  recent.add(cur, safeThumb(cur));
  S.previous = cur;
  S.selected = 0;
  S.t = 0;
  setDoc(makeGradient(seed, cur));
}

function loadDoc(doc, label) {
  const d = sanitizeDoc(doc);
  if (!d) return;
  const cur = S.doc;
  recent.add(cur, safeThumb(cur));
  S.previous = cur;
  S.selected = 0;
  S.t = 0;
  setDoc(d);
  if (label) toast(label);
}

function restorePrevious() {
  if (!S.previous) { toast('There is no previous gradient yet.'); return; }
  const prev = S.previous;
  S.previous = S.doc;
  S.selected = 0;
  S.t = 0;
  setDoc(sanitizeDoc(prev));
  toast('Previous gradient restored. Press Previous again to swap back.');
}

function setFormat(fmt) {
  const f = { id: fmt.id, label: fmt.label, w: clampDim(fmt.w), h: clampDim(fmt.h) };
  setDoc({ ...S.doc, format: f });
  fitFrame();
}

function toggleEdit(force) {
  S.editPoints = typeof force === 'boolean' ? force : !S.editPoints;
  $('#btnEdit').classList.toggle('active', S.editPoints);
  $('#btnHide').innerHTML = `${icon(S.editPoints ? 'eye' : 'eyeoff')}<span>${S.editPoints ? 'Hide points' : 'Show points'}</span>`;
  $('#hint').textContent = S.editPoints ? 'DOUBLE CLICK TO ADD A POINT' : 'POINTS HIDDEN · PRESS H TO EDIT';
  renderHandles();
  scheduleSave();
}

// ---- menus ---------------------------------------------------------------------------------------------------
function closeMenus(except) {
  $$('.menu').forEach((m) => { if (m !== except) m.hidden = true; });
}
function toggleMenu(menu, build) {
  const open = menu.hidden;
  closeMenus();
  if (open) { build(); menu.hidden = false; }
}

function buildFormatMenu() {
  const m = $('#menuFormat');
  m.innerHTML = '';
  for (const f of FORMATS) {
    const b = document.createElement('button');
    b.className = 'item' + (S.doc.format.id === f.id ? ' on' : '');
    b.dataset.id = f.id;
    const s = 14 / Math.max(f.w, f.h);
    b.innerHTML = `<span class="shape"><i style="width:${Math.round(f.w * s)}px;height:${Math.round(f.h * s)}px"></i></span>${f.label}<span class="ratio">${f.ratio} · ${f.w}×${f.h}</span>`;
    b.addEventListener('click', () => { setFormat(f); closeMenus(); });
    m.appendChild(b);
  }
  const c = document.createElement('div');
  c.className = 'custom';
  c.innerHTML = `<input id="cfW" inputmode="numeric" value="${S.doc.format.w}" aria-label="Custom width"><span class="muted">×</span>
    <input id="cfH" inputmode="numeric" value="${S.doc.format.h}" aria-label="Custom height"><button id="cfGo">Custom</button>`;
  m.appendChild(c);
  $('#cfGo', c).addEventListener('click', () => {
    setFormat({ id: 'custom', label: 'Custom', w: $('#cfW', c).value, h: $('#cfH', c).value });
    closeMenus();
  });
}

const templateThumbs = new Map();
function buildTemplatesMenu() {
  const m = $('#menuTemplates');
  m.innerHTML = '<div class="menu-title"><span class="label">TEMPLATE PACK</span><span class="label dim">' + TEMPLATES.length + ' LOOKS</span></div><div class="grid"></div>';
  const grid = $('.grid', m);
  TEMPLATES.forEach((tpl, k) => {
    const doc = applyTemplate(tpl, S.doc, 1000 + k);
    const key = `${tpl.name}|${S.doc.format.w}x${S.doc.format.h}`;
    if (!templateThumbs.has(key)) templateThumbs.set(key, safeThumb(doc));
    const b = document.createElement('button');
    b.className = 'tcard';
    b.innerHTML = `<span class="img" style="background-image:url(${templateThumbs.get(key)})"></span><span class="cap">${tpl.name}<small>${doc.motion.mode.toUpperCase()}</small></span>`;
    b.addEventListener('click', () => { loadDoc(applyTemplate(tpl, S.doc, randomSeed()), `Template: ${tpl.name}`); closeMenus(); });
    grid.appendChild(b);
  });
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'JUST NOW';
  if (s < 3600) return `${Math.floor(s / 60)} MIN AGO`;
  if (s < 86400) return `${Math.floor(s / 3600)} H AGO`;
  return `${Math.floor(s / 86400)} D AGO`;
}

function buildRecentMenu() {
  const m = $('#menuRecent');
  m.innerHTML = `<div class="menu-title"><span class="label">RECENT</span>${recent.items.length ? '<button class="link" id="rcClear">Clear</button>' : ''}</div>`;
  if (!recent.items.length) {
    m.insertAdjacentHTML('beforeend', '<div class="empty">Gradients you leave behind show up here.</div>');
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  recent.items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'tcard';
    b.innerHTML = `<span class="img" style="background-image:url(${it.thumb || ''})"></span><span class="cap">${it.doc.paletteName || 'Gradient'}<small>${timeAgo(it.at)}</small></span>`;
    b.addEventListener('click', () => { loadDoc(it.doc); closeMenus(); });
    grid.appendChild(b);
  });
  m.appendChild(grid);
  $('#rcClear', m).addEventListener('click', (e) => { e.stopPropagation(); recent.clear(); buildRecentMenu(); });
}

// ---- export dialog ------------------------------------------------------------------------------------------
const EX = { type: 'png', w: 900, h: 1440, mult: 1, vres: 'hd', fps: 30, seconds: 5, abort: null, busy: false };
const isVideo = () => EX.type === 'webm' || EX.type === 'mp4';

function openExport() {
  closeMenus();
  EX.w = S.doc.format.w;
  EX.h = S.doc.format.h;
  if (!imageSize(EX.w, EX.h, EX.mult).ok) EX.mult = 1;
  const d = S.doc.motion.duration;
  EX.seconds = [3, 5, 10].reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a), 5);
  $('#exError').hidden = true;
  $('#exProg').hidden = true;
  $('#exBar').style.width = '0%';
  $('#exStatus').textContent = '';
  $('#exDest').textContent = S.server ? `SAVES TO ${S.server.outDir}` : 'SAVES TO YOUR DOWNLOADS FOLDER';
  $('#exType [data-v="mp4"]').title = S.server && S.server.ffmpeg ? 'H.264 MP4 (converted with ffmpeg)' : 'MP4 needs the Mesh Drift server with ffmpeg';
  if (EX.type === 'mp4' && $('#exType [data-v="mp4"]').disabled) EX.type = 'webm';
  $('#exportModal').hidden = false;
  syncExport();
}

function syncExport() {
  const setOn = (sel, v) => $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  setOn('#exType', EX.type);
  setOn('#exMult', EX.mult);
  setOn('#exVRes', EX.vres);
  setOn('#exFps', EX.fps);
  setOn('#exDur', EX.seconds);
  $('#exImage').hidden = isVideo();
  $('#exVideo').hidden = !isVideo();
  if (document.activeElement !== $('#exW')) $('#exW').value = EX.w;
  if (document.activeElement !== $('#exH')) $('#exH').value = EX.h;
  $$('#exportModal .seg button, #exW, #exH').forEach((b) => { b.disabled = EX.busy; });
  $$('#exMult button').forEach((b) => { b.disabled = EX.busy || !imageSize(EX.w, EX.h, +b.dataset.v).ok; });
  $('#exType [data-v="mp4"]').disabled = EX.busy || !(S.server && S.server.ffmpeg);
  const out = imageSize(EX.w, EX.h, EX.mult);
  $('#exOut').textContent = `Output: ${out.w} × ${out.h} px. Maximum edge ${MAX_EDGE} px.`;
  const vs = videoSize(S.doc.format.w, S.doc.format.h, EX.vres);
  $('#exVSize').textContent = `${vs.w} × ${vs.h}`;
  const loops = loopCount(EX.seconds, S.doc.motion.duration);
  $('#exLoops').textContent = S.doc.motion.mode === 'still'
    ? 'Motion is set to Still: only the grain moves.'
    : `${loops} whole loop${loops > 1 ? 's' : ''} of the ${f2(S.doc.motion.duration)} s motion, fitted to ${EX.seconds} s so the end meets the start.`;
  const label = { png: 'PNG', webp: 'WEBP', jpg: 'JPEG', webm: 'WEBM', mp4: 'MP4' }[EX.type];
  $('#exGo span').textContent = `Export ${label}`;
  $('#exGo').disabled = EX.busy || (!isVideo() && !out.ok);
  $('#exCancel').textContent = EX.busy ? 'Cancel export' : 'Cancel';
}

function closeExport() {
  if (EX.busy) { EX.abort?.abort(); return; }
  $('#exportModal').hidden = true;
}

async function saveBlob(blob, stem, ext) {
  if (S.server) {
    const r = await fetch(`/api/save?name=${encodeURIComponent(stem)}&ext=${ext}`, { method: 'POST', body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Saving failed (${r.status})`);
    return j;
  }
  if (ext === 'mp4') throw new Error('MP4 needs the Mesh Drift server.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${stem}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return { downloaded: true };
}

function progress(f, text) {
  $('#exProg').hidden = false;
  $('#exBar').style.width = `${Math.round(f * 100)}%`;
  $('#exStatus').textContent = text;
}

async function runExport() {
  if (EX.busy) return;
  EX.busy = true;
  $('#exError').hidden = true;
  syncExport();
  const doc = JSON.parse(JSON.stringify(S.doc));
  const wasPlaying = S.playing;
  try {
    let res, stem;
    if (!isVideo()) {
      const out = imageSize(EX.w, EX.h, EX.mult);
      progress(0.3, 'Rendering…');
      const blob = await exportImage(doc, { ext: EX.type, w: out.w, h: out.h, t: S.t });
      stem = fileStem(doc, out.w, out.h);
      progress(0.8, 'Saving…');
      res = await saveBlob(blob, stem, EX.type);
    } else {
      S.exporting = true;
      EX.abort = new AbortController();
      const vs = videoSize(doc.format.w, doc.format.h, EX.vres);
      const { blob } = await exportVideo(doc, {
        w: vs.w, h: vs.h, fps: EX.fps, seconds: EX.seconds, signal: EX.abort.signal,
        onProgress: (f) => progress(f, `Rendering ${Math.round(f * 100)}%… Keep this window open.`),
      });
      stem = fileStem(doc, vs.w, vs.h, `${EX.fps}fps ${EX.seconds}s`);
      progress(1, EX.type === 'mp4' ? 'Converting to MP4…' : 'Saving…');
      res = await saveBlob(blob, stem, EX.type);
    }
    progress(1, 'Done.');
    EX.busy = false;
    $('#exportModal').hidden = true;
    if (res.path) toast(`Saved · ${res.path}`, res.path);
    else toast(`Downloaded · ${stem}.${EX.type}`);
    window.dispatchEvent(new CustomEvent('gs-exported', { detail: res }));
  } catch (err) {
    EX.busy = false;
    $('#exProg').hidden = true;
    const msg = err && err.name === 'AbortError' ? 'Export cancelled.' : (err && err.message) || String(err);
    $('#exError').textContent = msg;
    $('#exError').hidden = false;
    window.dispatchEvent(new CustomEvent('gs-export-failed', { detail: msg }));
  } finally {
    S.exporting = false;
    EX.abort = null;
    S.playing = wasPlaying;
    markDirty();
    syncExport();
  }
}

function wireExport() {
  const seg = (sel, fn) => $$(`${sel} button`).forEach((b) => b.addEventListener('click', () => { if (!EX.busy) { fn(b.dataset.v); syncExport(); } }));
  seg('#exType', (v) => { EX.type = v; });
  seg('#exMult', (v) => { EX.mult = +v; });
  seg('#exVRes', (v) => { EX.vres = v; });
  seg('#exFps', (v) => { EX.fps = +v; });
  seg('#exDur', (v) => { EX.seconds = +v; });
  const ratio = () => S.doc.format.h / S.doc.format.w;
  $('#exW').addEventListener('change', () => { EX.w = clampDim($('#exW').value); EX.h = clampDim(EX.w * ratio()); syncExport(); });
  $('#exH').addEventListener('change', () => { EX.h = clampDim($('#exH').value); EX.w = clampDim(EX.h / ratio()); syncExport(); });
  $('#exClose').addEventListener('click', closeExport);
  $('#exCancel').addEventListener('click', closeExport);
  $('#exGo').addEventListener('click', runExport);
  $('#exportModal').addEventListener('pointerdown', (e) => { if (e.target.id === 'exportModal' && !EX.busy) closeExport(); });
}

// ---- wiring -------------------------------------------------------------------------------------------------
function wire() {
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnNew').addEventListener('click', () => newGradient());
  $('#btnPlay').addEventListener('click', () => togglePlay());
  $('#btnEdit').addEventListener('click', () => toggleEdit());
  $('#btnHide').addEventListener('click', () => toggleEdit());
  $('#btnPrev').addEventListener('click', restorePrevious);
  $('#btnFormat').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#menuFormat'), buildFormatMenu); });
  $('#btnTemplates').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#menuTemplates'), buildTemplatesMenu); });
  $('#btnRecent').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu($('#menuRecent'), buildRecentMenu); });
  $$('.menu').forEach((m) => m.addEventListener('click', (e) => e.stopPropagation()));
  document.addEventListener('click', () => closeMenus());
  $('#btnHelp').addEventListener('click', () => { $('#helpModal').hidden = false; });
  $$('#helpModal [data-close]').forEach((b) => b.addEventListener('click', () => { $('#helpModal').hidden = true; }));
  $('#helpModal').addEventListener('pointerdown', (e) => { if (e.target.id === 'helpModal') $('#helpModal').hidden = true; });
  $('#btnExport').addEventListener('click', openExport);
  wireExport();

  $('#docName').addEventListener('change', () => {
    const name = $('#docName').value.trim() || 'Untitled gradient';
    setDoc({ ...S.doc, name });
  });
  $('#docName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => { t.hidden = t.dataset.tab !== b.dataset.tab; });
  }));

  $('#btnRandColors').addEventListener('click', () => setDoc(randomizeColors(S.doc, randomSeed())));
  $('#btnVariation').addEventListener('click', () => setDoc(generateVariation(S.doc, randomSeed())));
  $('#btnRandMotion').addEventListener('click', () => setDoc(randomizeMotion(S.doc, randomSeed())));
  $('#btnResetFinish').addEventListener('click', () => setDoc({ ...S.doc, finish: defaultFinish() }));
  $('#animGrain').addEventListener('change', (e) => { hist.record(S.doc); patch('finish', 'animatedGrain', e.target.checked); onDocChanged(); });

  const modes = $('#modes');
  MODES.forEach((m, k) => {
    const b = document.createElement('button');
    b.className = 'mode';
    b.dataset.mode = m.id;
    b.innerHTML = `<b>${pad2(k + 1)}</b><span>${m.label}</span>`;
    b.addEventListener('click', () => {
      hist.record(S.doc);
      patch('motion', 'mode', m.id);
      if (m.id !== 'still' && !S.playing) togglePlay(true);
      onDocChanged();
    });
    modes.appendChild(b);
  });

  // selected point
  $('#selHex').addEventListener('change', () => {
    const c = normalizeHex($('#selHex').value);
    if (c) { setPointColor(c); syncPanel(); scheduleSave(); } else $('#selHex').value = S.doc.points[S.selected].color;
  });
  $('#selHex').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#selLock').addEventListener('click', () => toggleLock());
  $('#selDelete').addEventListener('click', () => deletePoint());
  $('#selSwatch').addEventListener('click', () => {
    const box = $('#pickerBox');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      if (!picker) {
        picker = new ColorPicker(box, {
          onBegin: () => { hist.record(S.doc); picker.dragging = true; },
          onInput: (hex) => setPointColor(hex, { record: false }),
          onCommit: () => { picker.dragging = false; syncPanel(); scheduleSave(); },
        });
      }
      picker.set(S.doc.points[S.selected].color);
    }
  });
  const quick = $('#quick');
  QUICK_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { setPointColor(c); syncPanel(); scheduleSave(); });
    quick.appendChild(b);
  });

  // canvas
  $('#frame').addEventListener('dblclick', (e) => {
    if (!S.editPoints || e.target.closest('.handle')) return;
    const [u, v] = frameUv(e);
    addPointAt(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
  });
  $('#frame').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.handle')) return;
    closeMenus();
  });
  new ResizeObserver(() => fitFrame()).observe($('#stage'));

  document.addEventListener('keydown', onKey);
}

function undo() {
  const d = hist.undo(S.doc);
  if (d) { S.doc = d; S.selected = Math.min(S.selected, d.points.length - 1); onDocChanged(); fitFrame(); }
}
function redo() {
  const d = hist.redo(S.doc);
  if (d) { S.doc = d; S.selected = Math.min(S.selected, d.points.length - 1); onDocChanged(); fitFrame(); }
}

function onKey(e) {
  const typing = e.target.closest('input, textarea, [contenteditable]') && e.target.type !== 'range' && e.target.type !== 'checkbox';
  if (e.key === 'Escape') {
    closeMenus();
    if (!$('#helpModal').hidden) $('#helpModal').hidden = true;
    else if (!$('#exportModal').hidden) closeExport();
    return;
  }
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (!$('#exportModal').hidden) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'n': case 'N': newGradient(); break;
    case 'v': case 'V': setDoc(generateVariation(S.doc, randomSeed())); break;
    case 'c': case 'C': setDoc(randomizeColors(S.doc, randomSeed())); break;
    case 'e': case 'E': openExport(); break;
    case 'h': case 'H': toggleEdit(); break;
    case 'l': case 'L': toggleLock(); break;
    case '[': select((S.selected - 1 + S.doc.points.length) % S.doc.points.length); break;
    case ']': select((S.selected + 1) % S.doc.points.length); break;
    case 'Delete': case 'Backspace': deletePoint(); break;
    case '?': $('#helpModal').hidden = false; break;
    default: break;
  }
}

// ---- server -------------------------------------------------------------------------------------------------
async function connectServer() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    const j = await r.json();
    if (j.app === 'mesh-drift') S.server = j;
  } catch { S.server = null; }
  if (S.server) {
    const beat = () => fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
    beat();
    setInterval(beat, 5000);
    document.addEventListener('visibilitychange', beat);
  }
}

// ---- start --------------------------------------------------------------------------------------------------
function start() {
  paintIcons();
  buildSliders();
  wire();
  const prefs = readJSON(KEY_PREFS) || {};
  S.editPoints = prefs.editPoints !== false;

  // Every visit opens on a fresh gradient. The last session goes to Recent and Previous brings it back.
  const params = new URLSearchParams(location.search);
  const saved = sanitizeDoc(readJSON(KEY_SESSION));
  const seedParam = params.get('seed');
  const seed = seedParam ? parseInt(seedParam, 16) >>> 0 : randomSeed();
  const base = saved ? { name: 'Untitled gradient', format: saved.format, points: [], motion: { mode: 'drift' } } : null;
  S.doc = makeGradient(seed, base);
  const tplName = params.get('template');
  const tpl = tplName && TEMPLATES.find((t) => t.name.toLowerCase() === tplName.toLowerCase());
  if (tpl) S.doc = applyTemplate(tpl, base, seed);

  try {
    renderer = new GradientRenderer($('#view'));
  } catch (err) {
    $('#glError').hidden = false;
    $('#glError').textContent = `${err.message} Mesh Drift needs a browser with WebGL2 (Chrome or Edge).`;
  }
  if (saved && renderer) {
    recent.add(saved, safeThumb(saved));
    S.previous = saved;
  }
  toggleEdit(S.editPoints);
  fitFrame();
  syncPanel();
  scheduleSave();
  requestAnimationFrame(loop);
  connectServer();

  // a small hook for the automated tests
  window.gradientStudio = {
    get doc() { return S.doc; },
    get state() { return S; },
    setDoc: (d, opts) => setDoc(sanitizeDoc(d), opts),
    newGradient, restorePrevious, undo, redo, select, toggleLock, addPointAt, deletePoint, setFormat, togglePlay,
    recent, history: hist, openExport, exportState: EX, syncExport,
    setPhase: (t) => { S.t = t; markDirty(); },
    // Renders now and summarises the preview: size, mean colour, spread, and the colour at a few uv spots.
    stats: (spots = []) => {
      renderer.render(S.doc, S.t, { frame: S.frame });
      const px = renderer.readPixels(), w = renderer.canvas.width, h = renderer.canvas.height;
      const mean = [0, 0, 0], sq = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < px.length; i += 4 * 7) {
        for (let c = 0; c < 3; c++) { mean[c] += px[i + c]; sq[c] += px[i + c] * px[i + c]; }
        n++;
      }
      const m = mean.map((v) => v / n), sd = sq.map((v, c) => Math.sqrt(Math.max(0, v / n - m[c] * m[c])));
      const at = spots.map(([u, v]) => {
        const x = Math.min(w - 1, Math.round(u * (w - 1))), y = Math.min(h - 1, Math.round(v * (h - 1))), k = (y * w + x) * 4;
        return [px[k], px[k + 1], px[k + 2]];
      });
      // texture: average difference between neighbouring pixels (grain raises it, smooth gradients keep it near 0)
      let rough = 0, rn = 0;
      for (let y = 0; y < h; y += 9) {
        for (let x = 0; x < w - 1; x++) { const k = (y * w + x) * 4; rough += Math.abs(px[k] - px[k + 4]); rn++; }
      }
      return { w, h, mean: m, sd, at, rough: rough / rn };
    },
    ready: true,
  };
  document.documentElement.dataset.ready = '1';
}

start();
