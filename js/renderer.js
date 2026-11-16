// Canvas renderer for the note highway on the device's inset display: semitone lines, note bars that fill with
// each singer's colour where they hit, the "now" line, and each voice's pitch comet with a fading trail.
// Pure drawing — no game rules here.

import { foldDiff } from './scoring.js';

// Where a sung pitch (MIDI, tuning removed) is drawn. Singing a bar's note in any octave puts the line on that bar.
// Off a bar, the line stays in the octave it was just drawn in, so a steady voice never leaps an octave when the bars
// change under it, and switching octaves never yanks it. `last` ({ disp, t }) carries that octave between frames.
const ON_BAR = 1.3;
export function shownPitch(m, note, center, last, t) {
  if (m == null) return null;
  const onNote = note ? note.p + foldDiff(m, note.p) : null;
  const disp = onNote != null && Math.abs(onNote - note.p) < ON_BAR ? onNote
    : last.disp != null && t - last.t < 0.4 ? m + 12 * Math.round((last.disp - m) / 12)
    : onNote ?? center + foldDiff(m, center);
  last.disp = disp;
  last.t = t;
  return disp;
}

const SECONDS_SHOWN = 6.3; // across the whole display
const TRAIL_SECONDS = 1.05;

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.heads = new Map();
    this.lastNow = null;
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
  }

  setSong(chart) {
    this.chart = chart;
    const ps = chart.lines.flatMap((l) => l.notes.map((n) => n.p));
    this.lo = Math.min(...ps) - 1.5;
    this.hi = Math.max(...ps) + 2;
    this.heads.clear();
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
    if (this.chart) this.row = this.H / (this.hi - this.lo);
  }

  y(p) {
    return this.H - ((p - this.lo) / (this.hi - this.lo)) * this.H;
  }

  x(t, now) {
    return this.nowX + (t - now) * this.pps;
  }

  // players: [{ color, perf }] (perf.notes carry each singer's hit spans);
  // voices: [{ id, color, frames: [{ t, disp }] }], one per microphone.
  draw(now, players, voices) {
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
    const notes = players[0]?.perf?.notes ?? this.chart.lines.flatMap((l) => l.notes);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.t + n.d < tMin) continue;
      if (n.t > tMax) break;
      this.drawNote(n, i, now, players);
    }

    ctx.fillStyle = 'rgba(255,254,249,.6)';
    ctx.fillRect(this.nowX - 1, 0, 2, this.H);

    for (const v of voices) this.drawVoice(v, now, dt);
  }

  drawNote(n, i, now, players) {
    const { ctx } = this;
    const x0 = this.x(n.t, now), x1 = this.x(n.t + n.d - 0.06, now);
    // Bars never get thinner than 14 px, so a song with a wide range still has bars you can aim at.
    const hh = Math.max(14, Math.min(36, this.row * 0.84)), y0 = this.y(n.p) - hh / 2, r = Math.min(6, hh / 2);
    ctx.beginPath();
    ctx.roundRect(x0, y0, Math.max(r * 2, x1 - x0), hh, r);
    ctx.fillStyle = 'rgba(255,254,249,.08)';
    ctx.fill();
    // Each singer on this line fills their own band of the bar where they hit it.
    const who = players.filter((pl) => pl.perf && !pl.perf.notes[i]?.skip);
    if (who.some((pl) => pl.perf.notes[i]?.spans.length)) {
      ctx.save();
      ctx.clip();
      who.forEach((pl, j) => {
        ctx.fillStyle = pl.color;
        for (const [s, e] of pl.perf.notes[i].spans) ctx.fillRect(this.x(s, now), y0 + (j * hh) / who.length, (e - s) * this.pps + 0.5, hh / who.length);
      });
      ctx.restore();
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = n.golden ? 'rgba(255,210,63,.85)' : 'rgba(255,254,249,.34)';
    ctx.stroke();
  }

  drawVoice(v, now, dt) {
    const { ctx } = this;
    const frames = v.frames;
    ctx.lineCap = 'round';
    ctx.strokeStyle = v.color;
    let prev = null;
    for (let k = Math.max(0, frames.length - 200); k < frames.length; k++) {
      const f = frames[k];
      if (f.t > now + 0.02) break;
      if (f.disp == null || now - f.t > TRAIL_SECONDS) { prev = null; continue; }
      if (prev && f.t - prev.t < 0.08) {
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
    let head = this.heads.get(v.id);
    if (!head || Math.abs(target - head.y) > this.H * 0.4) this.heads.set(v.id, (head = { y: target, vy: 0 }));
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

  destroy() {
    window.removeEventListener('resize', this.onResize);
  }
}
