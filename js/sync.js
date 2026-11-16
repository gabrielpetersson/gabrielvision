// @ts-check
// Learns this device's audio delay from the singing itself. Bluetooth headphones (and some mics) add a delay the
// browser can't see: the music reaches the singer late, so they sing late against the screen, and every note scores
// late. Every few seconds this tries shifting the last stretch of singing earlier or later and keeps the shift that puts
// the most of it on the bars' notes (any octave): the same thing the score rewards, so a singer who comes in a little
// late but holds notes on time isn't over-corrected.
import { foldDiff } from './scoring.js';

const LOOK = 20; // seconds of singing each fit looks at
const EVERY = 5; // seconds between fits
const MIN_FRAMES = 150; // voiced frames needed for a fit (about 2.5 s of singing)
const SHIFTS = { from: -0.2, to: 0.4, step: 0.02 };
const BETTER = 1.05; // a shift has to put 5% more of the voice on the notes than staying put
export const MAX_DELAY = 0.6;

export class AutoDelay {
  /** @param {number} seconds the delay to start from @param {Chart} chart */
  constructor(seconds, chart) {
    this.seconds = seconds;
    this.tuning = chart.tuning ?? 0;
    this.notes = chart.lines.flatMap((l) => l.notes).sort((a, b) => a.t - b.t);
    /** @type {[number, number][]} voiced frames (song time as scored, MIDI) of the last LOOK seconds */
    this.frames = [];
    this.lastFit = -Infinity;
  }

  /** The bar sounding at song time t, if any. @param {number} t */
  barAt(t) {
    let lo = 0, hi = this.notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, n = this.notes[mid];
      if (t < n.t) hi = mid - 1;
      else if (t > n.t + n.d) lo = mid + 1;
      else return n;
    }
    return null;
  }

  /** How many of the recent frames sit on their bar's note if the voice is `s` seconds later than scored. @param {number} s */
  onNotes(s) {
    let k = 0;
    for (const [t, m] of this.frames) {
      const n = this.barAt(t - s);
      if (n && Math.abs(foldDiff(m - this.tuning, n.p)) < 1.3) k++;
    }
    return k;
  }

  /** One pitch frame in song time (as scored with the current delay). Returns true when the delay changed.
   * @param {number} t @param {number | null} midi */
  observe(t, midi) {
    if (midi != null) this.frames.push([t, midi]);
    while (this.frames.length && this.frames[0][0] < t - LOOK) this.frames.shift();
    if (t - this.lastFit < EVERY || this.frames.length < MIN_FRAMES) return false;
    this.lastFit = t;
    const stay = this.onNotes(0);
    /** @type {[number, number][]} */
    const fits = [];
    for (let s = SHIFTS.from; s <= SHIFTS.to + 1e-9; s += SHIFTS.step) fits.push([s, this.onNotes(s)]);
    const top = Math.max(...fits.map(([, k]) => k));
    // A song that repeats a note also fits a beat away, so of the shifts that fit (nearly) best, take the smallest.
    const best = fits.filter(([, k]) => k >= top * 0.97).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0][0];
    if (Math.abs(best) < 0.01 || top < stay * BETTER) return false;
    const next = Math.max(0, Math.min(MAX_DELAY, this.seconds + best));
    if (Math.abs(next - this.seconds) < 0.02) return false;
    this.seconds = next;
    // The frames so far were scored with the old delay.
    this.frames = [];
    return true;
  }
}
