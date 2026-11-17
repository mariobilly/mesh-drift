// HSV colour picker: saturation/value square, hue strip, hex and RGB fields, and the screen eyedropper.

import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, normalizeHex } from './color.js';

export class ColorPicker {
  /** onInput(hex) fires while dragging; onCommit() once the gesture ends (for undo). onBegin() before a change. */
  constructor(root, { onBegin = () => {}, onInput = () => {}, onCommit = () => {} } = {}) {
    this.root = root;
    this.cb = { onBegin, onInput, onCommit };
    this.hsv = [0, 0, 0];
    root.classList.add('picker');
    root.innerHTML = `
      <div class="pk-sv"><canvas width="240" height="150"></canvas><i class="pk-knob"></i></div>
      <div class="pk-row">
        <button class="pk-eye" type="button" title="Pick a colour from the screen" aria-label="Eyedropper">
          <svg viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9M3 21v-3l9-9m3-3 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3L15 6"/></svg>
        </button>
        <i class="pk-chip"></i>
        <div class="pk-hue"><canvas width="240" height="12"></canvas><i class="pk-hknob"></i></div>
      </div>
      <div class="pk-fields">
        <label><input data-c="0" inputmode="numeric" maxlength="3"><span>R</span></label>
        <label><input data-c="1" inputmode="numeric" maxlength="3"><span>G</span></label>
        <label><input data-c="2" inputmode="numeric" maxlength="3"><span>B</span></label>
      </div>`;
    this.sv = root.querySelector('.pk-sv canvas');
    this.hue = root.querySelector('.pk-hue canvas');
    this.knob = root.querySelector('.pk-knob');
    this.hknob = root.querySelector('.pk-hknob');
    this.chip = root.querySelector('.pk-chip');
    this.fields = [...root.querySelectorAll('.pk-fields input')];
    this.drawHue();
    this.drag(this.sv, (fx, fy) => { this.hsv = [this.hsv[0], fx, 1 - fy]; });
    this.drag(this.hue, (fx) => { this.hsv = [Math.min(359.9, fx * 360), this.hsv[1], this.hsv[2]]; });
    this.fields.forEach((f) => f.addEventListener('change', () => {
      const rgb = this.fields.map((x) => Math.max(0, Math.min(255, parseInt(x.value, 10) || 0)) / 255);
      this.cb.onBegin();
      this.set(rgbToHex(rgb), true);
      this.cb.onCommit();
    }));
    const eye = root.querySelector('.pk-eye');
    if (!('EyeDropper' in window)) eye.hidden = true;
    eye.addEventListener('click', async () => {
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        this.cb.onBegin();
        this.set(normalizeHex(sRGBHex), true);
        this.cb.onCommit();
      } catch { /* cancelled */ }
    });
  }

  drag(canvas, apply) {
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      apply(fx, fy);
      this.paint();
      this.cb.onInput(this.hex());
    };
    canvas.parentElement.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.parentElement.setPointerCapture(e.pointerId);
      this.cb.onBegin();
      at(e);
      const move = (ev) => at(ev);
      const up = () => {
        canvas.parentElement.removeEventListener('pointermove', move);
        canvas.parentElement.removeEventListener('pointerup', up);
        canvas.parentElement.removeEventListener('pointercancel', up);
        this.cb.onCommit();
      };
      canvas.parentElement.addEventListener('pointermove', move);
      canvas.parentElement.addEventListener('pointerup', up);
      canvas.parentElement.addEventListener('pointercancel', up);
    });
  }

  hex() { return rgbToHex(hsvToRgb(this.hsv)); }

  /** Shows `hex`. When emit is true the change is reported like a drag. */
  set(hex, emit = false) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const hsv = rgbToHsv(rgb);
    // keep the hue when the colour is grey or black, so the square does not jump to red
    if (hsv[1] < 1e-4 || hsv[2] < 1e-4) hsv[0] = this.hsv[0];
    this.hsv = hsv;
    this.paint();
    if (emit) this.cb.onInput(this.hex());
  }

  drawHue() {
    const g = this.hue.getContext('2d');
    const grad = g.createLinearGradient(0, 0, this.hue.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, rgbToHex(hsvToRgb([i * 60 % 360, 1, 1])));
    g.fillStyle = grad;
    g.fillRect(0, 0, this.hue.width, this.hue.height);
  }

  paint() {
    const g = this.sv.getContext('2d'), W = this.sv.width, H = this.sv.height;
    g.fillStyle = rgbToHex(hsvToRgb([this.hsv[0], 1, 1]));
    g.fillRect(0, 0, W, H);
    const wg = g.createLinearGradient(0, 0, W, 0);
    wg.addColorStop(0, '#fff');
    wg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wg;
    g.fillRect(0, 0, W, H);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(0,0,0,0)');
    bg.addColorStop(1, '#000');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    this.knob.style.left = `${this.hsv[1] * 100}%`;
    this.knob.style.top = `${(1 - this.hsv[2]) * 100}%`;
    this.hknob.style.left = `${(this.hsv[0] / 360) * 100}%`;
    const hex = this.hex();
    this.chip.style.background = hex;
    this.knob.style.background = hex;
    const rgb = hexToRgb(hex);
    this.fields.forEach((f, i) => { if (document.activeElement !== f) f.value = Math.round(rgb[i] * 255); });
  }
}
