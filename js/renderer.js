// Canvas renderer for the note highway: scrolling glass note capsules, beat grid, the "now" line,
// each singer's pitch comet with its trail, and spark particles. Pure drawing — no game rules here.

const GOLD = '#FFD66B';

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

function glowSprite(color, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(color, 0.9));
  grad.addColorStop(0.25, rgba(color, 0.45));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export class StageRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.rings = [];
    this.sprites = new Map();
    this.heads = new Map();
    this.lastNow = null;
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
  }

  sprite(color) {
    if (!this.sprites.has(color)) this.sprites.set(color, glowSprite(color));
    return this.sprites.get(color);
  }

  // theme: { accent, lineColors? } — lineColors tints each line's notes with its singer when friends take turns.
  setSong(chart, theme) {
    this.chart = chart;
    this.theme = theme;
    const ps = chart.lines.flatMap((l) => l.notes.map((n) => n.p));
    this.lo = Math.min(...ps) - 2;
    this.hi = Math.max(...ps) + 2;
    this.particles = [];
    this.rings = [];
    this.heads.clear();
    this.layout();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;
    this.layout();
  }

  layout() {
    const { W, H } = this;
    const narrow = W < 700;
    this.top = H * (narrow ? 0.2 : 0.19);
    this.bottom = H * (narrow ? 0.6 : 0.66);
    this.nowX = Math.max(70, W * (narrow ? 0.2 : 0.24));
    this.pps = Math.max(150, Math.min(440, W * 0.21));
    if (this.chart) {
      this.row = (this.bottom - this.top) / (this.hi - this.lo);
      this.noteH = Math.max(9, Math.min(30, this.row * 0.8));
    }
  }

  y(p) {
    return this.bottom - ((p - this.lo) / (this.hi - this.lo)) * (this.bottom - this.top);
  }

  x(t, now) {
    return this.nowX + (t - now) * this.pps;
  }

  burst(x, y, color, count = 14, power = 1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (60 + Math.random() * 220) * power;
      this.particles.push({ x, y, vx: Math.cos(a) * v - 80, vy: Math.sin(a) * v - 40, life: 1, decay: 1.2 + Math.random() * 1.2, size: 2 + Math.random() * 3, color });
    }
  }

  ring(x, y, color) {
    this.rings.push({ x, y, r: 6, life: 1, color });
  }

  // players: [{ id, color, frames (history with t, disp, credit), live: { midi, credit }, perf }]
  // voices: the pitch comets to draw (one per microphone); defaults to one per player.
  draw(now, players, beat, voices = players) {
    const { ctx, W, H } = this;
    const dt = this.lastNow == null ? 0 : Math.max(0, Math.min(0.05, now - this.lastNow));
    this.lastNow = now;
    ctx.clearRect(0, 0, W, H);
    if (!this.chart) return;
    const accent = this.theme.accent;
    const pastSecs = this.nowX / this.pps;
    const futureSecs = (W - this.nowX) / this.pps;

    // Highway glass band.
    const bandTop = this.top - this.noteH, bandBot = this.bottom + this.noteH;
    const band = ctx.createLinearGradient(0, bandTop, 0, bandBot);
    band.addColorStop(0, 'rgba(6,7,14,0.62)');
    band.addColorStop(0.5, 'rgba(6,7,14,0.42)');
    band.addColorStop(1, 'rgba(6,7,14,0.62)');
    ctx.fillStyle = band;
    ctx.fillRect(0, bandTop, W, bandBot - bandTop);
    const edge = ctx.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, rgba(accent, 0));
    edge.addColorStop(0.25, rgba(accent, 0.55 + beat.pulse * 0.35));
    edge.addColorStop(1, rgba(accent, 0.08));
    ctx.fillStyle = edge;
    ctx.fillRect(0, bandTop, W, 1.5);
    ctx.fillRect(0, bandBot - 1.5, W, 1.5);

    // Semitone guide lines (C notes a little stronger).
    for (let p = Math.ceil(this.lo); p <= this.hi; p++) {
      const yy = Math.round(this.y(p)) + 0.5;
      ctx.fillStyle = p % 12 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(0, yy, W, 1);
    }

    // Beat grid scrolling with the music.
    const spb = 60 / this.chart.bpm, off = this.chart.beatOffset || 0;
    const firstBeat = Math.floor((now - pastSecs - off) / spb);
    for (let b = firstBeat; off + b * spb < now + futureSecs; b++) {
      const xx = Math.round(this.x(off + b * spb, now)) + 0.5;
      const bar = b % this.chart.beatsPerBar === 0;
      ctx.fillStyle = bar ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(xx, bandTop, 1, bandBot - bandTop);
    }

    // Past region dims slightly so the future reads first.
    const past = ctx.createLinearGradient(0, 0, this.nowX, 0);
    past.addColorStop(0, 'rgba(4,5,10,0.55)');
    past.addColorStop(1, 'rgba(4,5,10,0)');
    ctx.fillStyle = past;
    ctx.fillRect(0, bandTop, this.nowX, bandBot - bandTop);

    // Notes.
    const perf0 = players[0]?.perf;
    const notes = perf0 ? perf0.notes : this.chart.lines.flatMap((l) => l.notes);
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.t + n.d < now - pastSecs) continue;
      if (n.t > now + futureSecs) break;
      this.drawNote(n, i, now, players, accent);
    }

    // Now line.
    const nowGrad = ctx.createLinearGradient(0, bandTop, 0, bandBot);
    nowGrad.addColorStop(0, 'rgba(255,255,255,0)');
    nowGrad.addColorStop(0.5, `rgba(255,255,255,${0.75 + beat.pulse * 0.25})`);
    nowGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rgba(accent, 0.18 + beat.pulse * 0.2);
    ctx.fillRect(this.nowX - 5, bandTop, 10, bandBot - bandTop);
    ctx.fillStyle = nowGrad;
    ctx.fillRect(this.nowX - 1, bandTop, 2, bandBot - bandTop);

    // Pitch trails and comets.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const v of voices) this.drawTrail(v, now, pastSecs);
    for (const v of voices) this.drawComet(v, now, dt);
    this.drawParticles(dt);
    ctx.restore();
  }

  drawNote(n, i, now, players, accent) {
    const { ctx } = this;
    const x0 = this.x(n.t, now) + 1.5;
    const x1 = this.x(n.t + n.d, now) - 1.5;
    const w = Math.max(this.noteH, x1 - x0);
    const h = this.noteH;
    const yc = this.y(n.p);
    const y0 = yc - h / 2;
    const color = n.golden ? GOLD : this.theme.lineColors?.[n.line] ?? accent;
    const active = now >= n.t && now <= n.t + n.d;
    const done = n.done;
    const missed = done && players.every((pl) => (pl.perf.notes[i]?.acc ?? 0) < 0.5);
    const alpha = missed ? 0.35 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    // Soft outer glow.
    ctx.fillStyle = rgba(color, active ? 0.28 : 0.13);
    ctx.beginPath();
    ctx.roundRect(x0 - 4, y0 - 4, w + 8, h + 8, (h + 8) / 2);
    ctx.fill();
    // Glass body.
    const body = ctx.createLinearGradient(0, y0, 0, y0 + h);
    body.addColorStop(0, rgba(color, active ? 0.55 : 0.38));
    body.addColorStop(0.55, rgba(color, 0.14));
    body.addColorStop(1, rgba(color, 0.28));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, h / 2);
    ctx.fill();

    // Sung portions fill the capsule with each singer's light.
    ctx.save();
    ctx.clip();
    for (const pl of players) {
      const pn = pl.perf.notes[i];
      if (!pn?.spans.length) continue;
      const fill = n.golden ? GOLD : pl.color;
      for (const [s, e] of pn.spans) {
        const sx = this.x(s - 0.03, now), ex = this.x(e + 0.03, now);
        const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.45, rgba(fill, 0.95));
        g.addColorStop(1, rgba(fill, 0.75));
        ctx.fillStyle = g;
        ctx.fillRect(sx, y0, ex - sx, h);
      }
    }
    ctx.restore();

    // Rim and highlight.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(color, active ? 1 : 0.85);
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, h / 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(x0 + h * 0.45, y0 + h * 0.18, Math.max(0, w - h * 0.9), 1.2);
    if (n.golden) {
      const shimmer = ((now * 0.9 + i * 0.37) % 1.6) / 1.6;
      const sx = x0 + shimmer * w;
      const sg = ctx.createLinearGradient(sx - 18, 0, sx + 18, 0);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.roundRect(x0, y0, w, h, h / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawTrail(pl, now, pastSecs) {
    const { ctx } = this;
    const pts = pl.frames;
    let prev = null;
    for (let k = 0; k < pts.length; k++) {
      const f = pts[k];
      if (f.t < now - pastSecs || f.disp == null) { prev = null; continue; }
      if (f.t > now + 0.02) break;
      const x = this.x(f.t, now), y = this.y(f.disp);
      if (prev && f.t - prev.t < 0.08) {
        const age = Math.max(0, Math.min(1, (now - f.t) / pastSecs));
        const good = f.credit > 0.6;
        ctx.strokeStyle = good ? rgba(n0(pl, GOLD), 0.9 * (1 - age)) : rgba(pl.color, 0.75 * (1 - age));
        ctx.lineWidth = (good ? 5 : 3) * (1 - age * 0.6);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      prev = { x, y, t: f.t };
    }
  }

  drawComet(pl, now, dt) {
    const { ctx } = this;
    const last = pl.frames[pl.frames.length - 1];
    const singing = last && last.disp != null && now - last.t < 0.25;
    let head = this.heads.get(pl.id);
    if (!head) {
      head = { y: (this.top + this.bottom) / 2, vy: 0, alpha: 0.3 };
      this.heads.set(pl.id, head);
    }
    if (singing) {
      const target = this.y(last.disp);
      // Critically damped spring so the comet glides instead of jittering.
      const k = 900, c = 2 * Math.sqrt(k);
      head.vy += (k * (target - head.y) - c * head.vy) * dt;
      head.y += head.vy * dt;
      if (Math.abs(target - head.y) > 120) head.y = target;
    }
    head.alpha += ((singing ? 1 : 0.28) - head.alpha) * Math.min(1, dt * 10);
    const hot = singing && last.credit > 0.6;
    const r = (hot ? 46 : 34) * (0.6 + head.alpha * 0.4);
    const spr = this.sprite(hot ? GOLD : pl.color);
    ctx.globalAlpha = head.alpha;
    ctx.drawImage(spr, this.nowX - r, head.y - r, r * 2, r * 2);
    ctx.drawImage(this.sprite('#ffffff'), this.nowX - r * 0.35, head.y - r * 0.35, r * 0.7, r * 0.7);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.nowX, head.y, hot ? 6.5 : 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (hot && Math.random() < 0.6) {
      this.particles.push({ x: this.nowX, y: head.y, vx: -120 - Math.random() * 160, vy: (Math.random() - 0.5) * 120, life: 1, decay: 2 + Math.random() * 1.5, size: 1.5 + Math.random() * 2.5, color: GOLD });
    }
    pl.headY = head.y;
  }

  drawParticles(dt) {
    const { ctx } = this;
    for (const p of this.particles) {
      p.life -= p.decay * dt;
      p.vy += 240 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.min(1, p.life);
      const s = p.size * 4;
      ctx.drawImage(this.sprite(p.color), p.x - s, p.y - s, s * 2, s * 2);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) {
      r.life -= dt * 2.2;
      r.r += dt * 160;
      if (r.life <= 0) continue;
      ctx.globalAlpha = r.life;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rings = this.rings.filter((r) => r.life > 0);
    ctx.globalAlpha = 1;
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
  }
}

// Golden trail color only when a singer is on a golden note; otherwise warm white-gold.
function n0(pl, gold) {
  return pl.live?.note?.golden ? gold : '#FFE9A8';
}
