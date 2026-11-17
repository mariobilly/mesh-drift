// WebGL2 mesh-gradient renderer. One full-screen triangle; the fragment shader blends every colour point in
// OKLab with a soft, shape-aware falloff, bends space with swirl and noise warp, then adds the finish
// (tone, vignette, grain) and a tiny dither so slow gradients never band.

import { hexToOklab } from './color.js';
import { animate, halfExtents } from './motion.js';

export const MAXP = 16;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
#define MAXP ${MAXP}
uniform vec2 uRes;
uniform vec2 uHalf;
uniform int uCount;
uniform vec2 uPos[MAXP];
uniform vec3 uLab[MAXP];
uniform vec3 uPt[MAXP];
uniform float uScale, uBlend, uRot, uSwirl, uWarp, uWarpScale;
uniform vec2 uStretch, uWarpPhase, uWarpSeed;
uniform float uGrain, uGrainSize, uGrainSeed, uVignette, uSat, uContrast, uExposure, uHue;
out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 grad2(vec2 p) { float a = hash12(p) * 6.2831853; return vec2(cos(a), sin(a)); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad2(i), f), b = dot(grad2(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad2(i + vec2(0, 1)), f - vec2(0, 1)), d = dot(grad2(i + vec2(1, 1)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// Two soft octaves: big organic bends without the cloudy, blotchy look of finer noise.
float fbm(vec2 p) {
  float s = 0.75 * gnoise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p;
  return s + 0.25 * gnoise(p);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 shapeSpace(vec2 p) { return (rot(-uRot) * p) / uStretch; }

vec3 oklab2lin(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 lin2srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  uv.y = 1.0 - uv.y;
  vec2 p = (uv - 0.5) * 2.0 * uHalf;

  p = rot(uSwirl * exp(-dot(p, p) * 1.6)) * p;
  vec2 q = p * uWarpScale + uWarpSeed + uWarpPhase;
  p += uWarp * vec2(fbm(q), fbm(q + vec2(5.2, 1.3)));
  vec2 sp = shapeSpace(p);

  float lw[MAXP];
  float lmax = -1e9;
  for (int i = 0; i < MAXP; i++) {
    if (i >= uCount) break;
    vec2 d = sp - shapeSpace(uPos[i]);
    float rr = length(d) / max(1e-3, uPt[i].x * uScale);
    float k = mix(3.2, 1.15, uPt[i].y);
    float l = log(max(uPt[i].z, 1e-3)) - pow(rr, k);
    lw[i] = l;
    lmax = max(lmax, l);
  }
  float sharp = mix(7.0, 1.0, uBlend);
  vec3 acc = vec3(0.0);
  float ws = 0.0, cs = 0.0;
  for (int i = 0; i < MAXP; i++) {
    if (i >= uCount) break;
    float w = exp(sharp * (lw[i] - lmax));
    acc += w * uLab[i];
    cs += w * length(uLab[i].yz);
    ws += w;
  }
  vec3 lab = acc / max(ws, 1e-6);
  // Averaging two opposite hues cancels their colour and leaves grey. Pull the chroma back towards the average
  // chroma of the colours being mixed, so transitions stay vivid instead of muddy.
  float c = length(lab.yz), cAvg = cs / max(ws, 1e-6);
  lab.yz *= mix(1.0, min(cAvg / max(c, 1e-4), 2.2), 0.7);

  lab.yz = rot(uHue) * lab.yz * uSat;
  lab.x = (lab.x - 0.5) * uContrast + 0.5;
  vec3 col = lin2srgb(oklab2lin(lab) * exp2(uExposure));

  col *= 1.0 - uVignette * smoothstep(0.35, 1.45, length((uv - 0.5) * 2.0));

  float cell = max(1.0, uGrainSize * min(uRes.x, uRes.y) / 1080.0);
  vec2 gc = floor(gl_FragCoord.xy / cell);
  float g = hash12(gc + uGrainSeed * 17.31) + hash12(gc * 1.37 + uGrainSeed * 3.1 + 11.0) - 1.0;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += g * uGrain * 0.24 * (0.45 + 0.55 * (1.0 - abs(lum * 2.0 - 1.0)));

  float dz = hash12(gl_FragCoord.xy + uGrainSeed * 7.7 + 3.0) + hash12(gl_FragCoord.yx * 1.13 + 5.0) - 1.0;
  col += dz / 255.0;
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const UNIFORMS = ['uRes', 'uHalf', 'uCount', 'uPos', 'uLab', 'uPt', 'uScale', 'uBlend', 'uRot', 'uSwirl', 'uWarp',
  'uWarpScale', 'uStretch', 'uWarpPhase', 'uWarpSeed', 'uGrain', 'uGrainSize', 'uGrainSeed', 'uVignette', 'uSat',
  'uContrast', 'uExposure', 'uHue'];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
  return sh;
}

export class GradientRenderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    this.preserve = preserve;
    this.labCache = new Map();
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.init(); this.lost = false; });
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: this.preserve, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)]));
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.pos = new Float32Array(MAXP * 2);
    this.lab = new Float32Array(MAXP * 3);
    this.pt = new Float32Array(MAXP * 3);
  }

  oklab(hex) {
    let v = this.labCache.get(hex);
    if (!v) { v = hexToOklab(hex); this.labCache.set(hex, v); }
    return v;
  }

  /** Draws `doc` at loop phase t. `frame` only moves the grain. */
  render(doc, t = 0, { frame = 0 } = {}) {
    if (this.lost) return;
    const gl = this.gl, L = this.loc, W = this.canvas.width, H = this.canvas.height;
    const half = halfExtents(W, H);
    const a = animate(doc, t, half);
    const n = Math.min(MAXP, doc.points.length);
    for (let i = 0; i < n; i++) {
      const p = doc.points[i], lab = this.oklab(p.color);
      this.pos[i * 2] = a.pos[i][0];
      this.pos[i * 2 + 1] = a.pos[i][1];
      this.lab.set(lab, i * 3);
      this.pt[i * 3] = p.radius;
      this.pt[i * 3 + 1] = p.softness;
      this.pt[i * 3 + 2] = p.influence;
    }
    const sh = doc.shape, fi = doc.finish, seed = doc.seed >>> 0;
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    gl.uniform2f(L.uRes, W, H);
    gl.uniform2f(L.uHalf, half[0], half[1]);
    gl.uniform1i(L.uCount, n);
    gl.uniform2fv(L.uPos, this.pos);
    gl.uniform3fv(L.uLab, this.lab);
    gl.uniform3fv(L.uPt, this.pt);
    gl.uniform1f(L.uScale, sh.scale * a.scaleMul);
    gl.uniform1f(L.uBlend, sh.blend);
    gl.uniform1f(L.uRot, (sh.rotation * Math.PI) / 180);
    gl.uniform1f(L.uSwirl, sh.swirl);
    gl.uniform1f(L.uWarp, sh.warp * a.warpMul);
    gl.uniform1f(L.uWarpScale, sh.warpScale);
    gl.uniform2f(L.uStretch, sh.stretchX, sh.stretchY);
    gl.uniform2f(L.uWarpPhase, a.warpPhase[0], a.warpPhase[1]);
    gl.uniform2f(L.uWarpSeed, (seed % 997) / 31, ((seed >>> 10) % 991) / 37);
    gl.uniform1f(L.uGrain, fi.grain);
    gl.uniform1f(L.uGrainSize, fi.grainSize);
    gl.uniform1f(L.uGrainSeed, fi.animatedGrain ? (frame % 4096) * 0.618 + 1 : 1);
    gl.uniform1f(L.uVignette, fi.vignette);
    gl.uniform1f(L.uSat, fi.saturation);
    gl.uniform1f(L.uContrast, fi.contrast);
    gl.uniform1f(L.uExposure, fi.exposure);
    gl.uniform1f(L.uHue, (fi.hue * Math.PI) / 180);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** RGBA pixels of the last frame, top row first (for the tests and colour sampling). */
  readPixels() {
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const row = W * 4, out = new Uint8Array(px.length);
    for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    return out;
  }

  dispose() {
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

/** One small shared renderer for template and Recent thumbnails. */
let thumbR = null;
export function thumbnail(doc, w = 120, t = 0) {
  const h = Math.max(16, Math.round((w * doc.format.h) / doc.format.w));
  if (!thumbR) thumbR = new GradientRenderer(document.createElement('canvas'), { preserve: true });
  thumbR.canvas.width = w;
  thumbR.canvas.height = h;
  thumbR.render(doc, t);
  return thumbR.canvas.toDataURL('image/jpeg', 0.82);
}
