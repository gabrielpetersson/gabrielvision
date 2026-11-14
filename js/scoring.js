// Pure scoring engine: feed it (song time, sung MIDI pitch or null) frames in time order and it
// scores every note by how close the voice stays to it. No DOM, no audio — offline tests use it too.

export const DIFFICULTY = {
  easy: { label: 'Easy', perfect: 0.6, window: 2.0 },
  normal: { label: 'Normal', perfect: 0.35, window: 1.3 },
  hard: { label: 'Hard', perfect: 0.2, window: 0.8 },
};

export const RATINGS = [
  { min: 0.9, key: 'perfect', label: 'Perfect', bonus: 1000 },
  { min: 0.75, key: 'great', label: 'Great', bonus: 600 },
  { min: 0.55, key: 'good', label: 'Good', bonus: 300 },
  { min: 0.3, key: 'ok', label: 'OK', bonus: 100 },
  { min: -1, key: 'miss', label: 'Missed', bonus: 0 },
];

export const TITLES = [
  { min: 0.95, title: 'Legend' },
  { min: 0.88, title: 'Superstar' },
  { min: 0.78, title: 'Headliner' },
  { min: 0.65, title: 'Rising Star' },
  { min: 0.5, title: 'Karaoke Regular' },
  { min: 0.3, title: 'Shower Singer' },
  { min: -1, title: 'Brave Soul' },
];

const POINTS_PER_SECOND = 500;
const HIT_ACCURACY = 0.5;
// The pitch detector needs ~2/3 of its 64 ms window voiced before it locks on, so onsets read this much late.
const DETECTOR_LAG = 0.045;

// Signed distance from the target in semitones, folded so any octave counts (SingStar rule).
export const foldDiff = (midi, target) => ((((midi - target) % 12) + 18) % 12) - 6;

export const ratingFor = (acc) => RATINGS.find((r) => acc >= r.min);
export const titleFor = (acc) => TITLES.find((r) => acc >= r.min).title;

export class Performance {
  constructor(chart, difficulty = 'normal') {
    this.diff = DIFFICULTY[difficulty];
    this.lines = chart.lines.map((line, li) => ({
      ...line,
      index: li,
      done: false,
      acc: 0,
      points: 0,
      bonus: 0,
      rating: null,
      lyric: null,
    }));
    this.notes = this.lines.flatMap((line) =>
      line.notes.map((n) => ({
        ...n,
        line: line.index,
        weight: POINTS_PER_SECOND * n.d * (n.golden ? 2 : 1),
        frames: 0,
        credit: 0,
        spans: [],
        sung: [],
        attack: null,
        done: false,
        acc: 0,
      })),
    );
    this.cursor = 0;
    this.lineCursor = 0;
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.multiplier = 1;
    this.events = [];
    this.live = { t: 0, midi: null, diff: null, credit: 0, note: null };
    this.cents = { sum: 0, sq: 0, n: 0 };
    this.octaveFrames = 0;
    this.inNoteVoiced = 0;
    this.range = { lo: Infinity, hi: -Infinity };
    this.lastT = 0;
  }

  credit(absDiff) {
    const { perfect, window } = this.diff;
    if (absDiff <= perfect) return 1;
    return Math.max(0, 1 - (absDiff - perfect) / (window - perfect));
  }

  // The scoring window skips the very start (consonants, scoops) and end (release) of each note.
  static window(n) {
    const lead = Math.min(0.07, n.d * 0.25);
    const tail = Math.min(0.05, n.d * 0.15);
    return [n.t + lead, n.t + n.d - tail];
  }

  feed(t, midi) {
    this.lastT = t;
    this.completeBefore(t);
    const n = this.noteAt(t);
    let diff = null, c = 0;
    if (n && midi != null) {
      diff = foldDiff(midi, n.p);
      c = this.credit(Math.abs(diff));
    }
    this.live = { t, midi, diff, credit: c, note: n };
    if (!n) return;
    if (c >= 0.5 && n.attack == null) n.attack = t;
    const [w0, w1] = Performance.window(n);
    if (t < w0 || t > w1) return;
    n.frames++;
    if (midi == null) return;
    n.credit += c;
    this.inNoteVoiced++;
    if (Math.abs(diff) < 1) {
      this.cents.sum += diff * 100;
      this.cents.sq += diff * diff * 10000;
      this.cents.n++;
      if (Math.abs(midi - n.p) > 9) this.octaveFrames++;
    }
    if (c >= 0.5) {
      const last = n.spans[n.spans.length - 1];
      if (last && t - last[1] < 0.06) last[1] = t;
      else n.spans.push([t, t]);
      n.sung.push(midi);
    }
  }

  // The note whose time (plus a little grace) contains t, scanning forward from the cursor.
  noteAt(t) {
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t + 0.05) return null;
      if (t <= n.t + n.d + 0.05) return n;
    }
    return null;
  }

  completeBefore(t) {
    while (this.cursor < this.notes.length) {
      const n = this.notes[this.cursor];
      if (t < n.t + n.d + 0.08) break;
      this.completeNote(n);
      this.cursor++;
    }
    while (this.lineCursor < this.lines.length) {
      const line = this.lines[this.lineCursor];
      if (t < line.end + 0.12) break;
      this.completeLine(line);
      this.lineCursor++;
    }
  }

  completeNote(n) {
    n.done = true;
    // Range uses each note's median sung pitch, so single-frame octave slips don't count.
    if (n.sung.length >= 3) {
      const m = [...n.sung].sort((a, b) => a - b)[n.sung.length >> 1];
      this.range.lo = Math.min(this.range.lo, m);
      this.range.hi = Math.max(this.range.hi, m);
    }
    n.acc = n.frames ? n.credit / n.frames : 0;
    const hit = n.acc >= HIT_ACCURACY;
    if (hit) {
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    } else this.combo = 0;
    this.multiplier = Math.min(4, 1 + Math.floor(this.combo / 6));
    const points = Math.round((n.weight * n.acc) / 10) * 10 * this.multiplier;
    this.score += points;
    this.lines[n.line].points += points;
    this.events.push({ type: 'note', note: n, acc: n.acc, hit, points });
  }

  completeLine(line) {
    const notes = this.notes.filter((n) => n.line === line.index);
    notes.forEach((n) => !n.done && this.completeNote(n));
    const dur = notes.reduce((s, n) => s + n.d, 0);
    line.acc = dur ? notes.reduce((s, n) => s + n.acc * n.d, 0) / dur : 0;
    line.rating = ratingFor(line.acc);
    line.bonus = line.rating.bonus;
    line.done = true;
    this.score += line.bonus;
    this.events.push({ type: 'line', line, rating: line.rating, acc: line.acc, bonus: line.bonus });
  }

  // Lyric check result for a finished line: ratio of expected words that were recognised.
  // Below 40% of the words, the line keeps only part of its points (25% when nothing matched).
  applyLyric(index, ratio, heard) {
    const line = this.lines[index];
    if (!line || line.lyric) return;
    const factor = ratio >= 0.4 ? 1 : 0.25 + (ratio / 0.4) * 0.75;
    const penalty = Math.round(((line.points + line.bonus) * (1 - factor)) / 10) * 10;
    line.lyric = { ratio, factor, penalty, heard };
    this.score -= penalty;
    this.events.push({ type: 'lyric', line, ratio, penalty, heard });
  }

  finish() {
    this.completeBefore(Infinity);
    const total = this.lines.reduce((s, l) => s + (l.end - l.start), 0);
    const factor = (l) => l.lyric?.factor ?? 1;
    const accuracy = total ? this.lines.reduce((s, l) => s + l.acc * (l.end - l.start) * factor(l), 0) / total : 0;
    const pitchAccuracy = total ? this.lines.reduce((s, l) => s + l.acc * (l.end - l.start), 0) / total : 0;
    const checked = this.lines.filter((l) => l.lyric);
    const lyricAccuracy = checked.length ? checked.reduce((s, l) => s + l.lyric.ratio, 0) / checked.length : null;
    const attacks = this.notes
      .filter((n) => n.attack != null && n.syl !== '~')
      .map((n) => n.attack - n.t - DETECTOR_LAG)
      .sort((a, b) => a - b);
    const sorted = [...this.lines].sort((a, b) => b.acc - a.acc);
    const { sum, sq, n } = this.cents;
    return {
      score: this.score,
      accuracy,
      pitchAccuracy,
      lyricAccuracy,
      title: titleFor(accuracy),
      stars: Math.max(0, Math.min(5, Math.round(accuracy * 10) / 2)),
      notesHit: this.notes.filter((x) => x.acc >= HIT_ACCURACY).length,
      notesTotal: this.notes.length,
      goldenHit: this.notes.filter((x) => x.golden && x.acc >= HIT_ACCURACY).length,
      goldenTotal: this.notes.filter((x) => x.golden).length,
      bestCombo: this.bestCombo,
      centsMean: n > 20 ? sum / n : null,
      centsSpread: n > 20 ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : null,
      lateMs: attacks.length > 5 ? attacks[Math.floor(attacks.length / 2)] * 1000 : null,
      otherOctave: this.inNoteVoiced > 20 ? this.octaveFrames / this.inNoteVoiced : 0,
      range: Number.isFinite(this.range.lo) ? this.range : null,
      bestLine: sorted[0],
      worstLine: sorted[sorted.length - 1],
      lines: this.lines.map((l) => ({ text: l.text, acc: l.acc, rating: l.rating?.key, lyric: l.lyric?.ratio ?? null })),
    };
  }
}
