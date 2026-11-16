// @ts-check
// Canvas renderer for the note highway on the device's inset display: semitone lines, note bars that fill with
// each singer's colour where they hit, the "now" line, and the voice's pitch line with a fading trail.
// Pure drawing — no game rules here.

import { foldDiff } from './scoring.js';

/** @typedef {import('./scoring.js').ScoredNote} ScoredNote */
/** @typedef {{ color: string, perf: { notes: ScoredNote[] } }} Lane a singer scored on this device */

// Where a sung pitch (MIDI, tuning removed) is drawn. Singing a bar's note in any octave puts the line on that bar.
// Off a bar, the line stays in the octave it was just drawn in, so a steady voice never leaps an octave when the bars
// change under it, and switching octaves never yanks it. `last` carries that octave between frames.
const ON_BAR = 1.3;
/** @param {number | null} m @param {Note | null} note @param {number} center @param {{ disp: number | null, t: number }} last @param {number} t */
export function shownPitch(m, note, center, last, t) {
  if (m == null) return null;
  const onNote = note ? note.p + foldDiff(m, note.p) : null;
  const disp = note && onNote != null && Math.abs(onNote - note.p) < ON_BAR ? onNote
    : last.disp != null && t - last.t < 0.4 ? m + 12 * Math.round((last.disp - m) / 12)
    : onNote ?? center + foldDiff(m, center);
  last.disp = disp;
  last.t = t;
  return disp;
}

const SECONDS_SHOWN = 6.3; // across the whole display
const TRAIL_SECONDS = 1.05;

export class StageRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    /** @type {Chart | null} */
    this.chart = null;
    this.W = 0;
    this.H = 0;
    this.lo = 0;
    this.hi = 1;
    this.nowX = 0;
    this.pps = 1;
    this.row = 1;
    /** @type {{ y: number, vy: number } | null} the voice's dot, gliding to its newest pitch */
    this.head = null;
    /** @type {number | null} */
    this.lastNow = null;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** @param {Chart} chart */
  setSong(chart) {
    this.chart = chart;
    const ps = chart.lines.flatMap((l) => l.notes.map((n) => n.p));
    this.lo = Math.min(...ps) - 1.5;
    this.hi = Math.max(...ps) + 2;
    this.head = null;
    this.lastNow = null;
    this.layout();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;
    this.layout();
  }

  layout() {
    this.nowX = this.W * 0.2;
    this.pps = this.W / SECONDS_SHOWN;
    this.row = this.H / (this.hi - this.lo);
  }

  /** @param {number} p */
  y(p) {
    return this.H - ((p - this.lo) / (this.hi - this.lo)) * this.H;
  }

  /** @param {number} t @param {number} now */
  x(t, now) {
    return this.nowX + (t - now) * this.pps;
  }

  /** @param {number} now song time @param {Lane[]} lanes singers scored here (their hits fill the bars)
   * @param {{ color: string, frames: Frame[] }[]} voices the voice line (none when nobody sings on this device) */
  draw(now, lanes, voices) {
    const { ctx } = this;
    if (this.canvas.clientWidth !== this.W || this.canvas.clientHeight !== this.H) this.resize();
    const dt = this.lastNow == null ? 0 : Math.max(0, Math.min(0.05, now - this.lastNow));
    this.lastNow = now;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.chart || !this.W) return;

    for (let m = Math.ceil(this.lo); m <= Math.floor(this.hi); m++) {
      ctx.fillStyle = m % 12 === 0 ? 'rgba(255,254,249,.11)' : 'rgba(255,254,249,.045)';
      ctx.fillRect(0, Math.round(this.y(m)), this.W, 1);
    }

    const tMin = now - this.nowX / this.pps, tMax = now + (this.W - this.nowX) / this.pps;
    /** @type {Note[]} */
    const notes = lanes[0]?.perf.notes ?? this.chart.lines.flatMap((l) => l.notes);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.t + n.d < tMin) continue;
      if (n.t > tMax) break;
      this.drawNote(n, i, now, lanes);
    }

    ctx.fillStyle = 'rgba(255,254,249,.6)';
    ctx.fillRect(this.nowX - 1, 0, 2, this.H);

    for (const v of voices) this.drawVoice(v, now, dt);
  }

  /** @param {Note} n @param {number} i @param {number} now @param {Lane[]} lanes */
  drawNote(n, i, now, lanes) {
    const { ctx } = this;
    const x0 = this.x(n.t, now), x1 = this.x(n.t + n.d - 0.06, now);
    // Bars never get thinner than 14 px, so a song with a wide range still has bars you can aim at.
    const hh = Math.max(14, Math.min(36, this.row * 0.84)), y0 = this.y(n.p) - hh / 2, r = Math.min(6, hh / 2);
    ctx.beginPath();
    ctx.roundRect(x0, y0, Math.max(r * 2, x1 - x0), hh, r);
    ctx.fillStyle = 'rgba(255,254,249,.08)';
    ctx.fill();
    // Each singer on this line fills their own band of the bar where they hit it.
    const who = lanes.filter((l) => !l.perf.notes[i].skip);
    if (who.some((l) => l.perf.notes[i].spans.length)) {
      ctx.save();
      ctx.clip();
      who.forEach((l, j) => {
        ctx.fillStyle = l.color;
        for (const [s, e] of l.perf.notes[i].spans) ctx.fillRect(this.x(s, now), y0 + (j * hh) / who.length, (e - s) * this.pps + 0.5, hh / who.length);
      });
      ctx.restore();
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = n.golden ? 'rgba(255,210,63,.85)' : 'rgba(255,254,249,.34)';
    ctx.stroke();
  }

  /** @param {{ color: string, frames: Frame[] }} v @param {number} now @param {number} dt */
  drawVoice(v, now, dt) {
    const { ctx } = this;
    const frames = v.frames;
    ctx.lineCap = 'round';
    ctx.strokeStyle = v.color;
    /** @type {Frame | null} */
    let prev = null;
    for (let k = Math.max(0, frames.length - 200); k < frames.length; k++) {
      const f = frames[k];
      if (f.t > now + 0.02) break;
      if (f.disp == null || now - f.t > TRAIL_SECONDS) { prev = null; continue; }
      if (prev?.disp != null && f.t - prev.t < 0.08) {
        const age = (now - f.t) / TRAIL_SECONDS;
        ctx.globalAlpha = (1 - age) * 0.85;
        ctx.lineWidth = 1 + (1 - age) * 4.5;
        ctx.beginPath();
        ctx.moveTo(this.x(prev.t, now), this.y(prev.disp));
        ctx.lineTo(this.x(f.t, now), this.y(f.disp));
        ctx.stroke();
      }
      prev = f;
    }
    ctx.globalAlpha = 1;
    const last = frames[frames.length - 1];
    if (!last || last.disp == null || now - last.t > 0.25) return;
    // The head glides to the newest pitch (critically damped), so it doesn't jitter between frames.
    const target = this.y(last.disp);
    let head = this.head;
    if (!head || Math.abs(target - head.y) > this.H * 0.4) this.head = head = { y: target, vy: 0 };
    const k = 900, c = 2 * Math.sqrt(k);
    head.vy += (k * (target - head.y) - c * head.vy) * dt;
    head.y += head.vy * dt;
    ctx.beginPath();
    ctx.arc(this.nowX, head.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = v.color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#171716';
    ctx.stroke();
  }
}
