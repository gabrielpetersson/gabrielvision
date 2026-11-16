// @ts-check
// Pure scoring engine: feed it (song time, sung MIDI pitch or null) frames in time order and it scores every note by
// how close the voice stays to it. No DOM, no audio: offline tests use it too.

/** @type {Record<Difficulty, { label: string, perfect: number, window: number }>} */
export const DIFFICULTY = {
  easy: { label: 'Easy', perfect: 0.9, window: 2.6 },
  normal: { label: 'Normal', perfect: 0.6, window: 2.0 },
  hard: { label: 'Hard', perfect: 0.3, window: 1.1 },
};

// A finished line's bonus by how much of it was sung in tune.
const LINE_BONUS = [[0.9, 1000], [0.75, 600], [0.55, 300], [0.3, 100]];

/** The titles a result can carry. rooms/worker.js accepts only these from other devices. */
export const TITLES = /** @type {const} */ ([
  [0.95, 'Legend'],
  [0.88, 'Superstar'],
  [0.78, 'Headliner'],
  [0.65, 'Rising Star'],
  [0.5, 'Karaoke Regular'],
  [0.3, 'Shower Singer'],
  [-1, 'Brave Soul'],
]);

const POINTS_PER_SECOND = 500;
const HIT_ACCURACY = 0.5;
// Holding a bar in tune for this share of it is full marks: nobody sings through every consonant, breath and release.
const HOLD = 0.6;

/** Signed distance from the target in semitones, folded so any octave counts (SingStar rule).
 * @param {number} midi @param {number} target */
export const foldDiff = (midi, target) => ((((midi - target) % 12) + 18) % 12) - 6;

/** @typedef {Note & { line: number, skip: boolean, weight: number, frames: number, credit: number, spans: [number, number][], done: boolean, acc: number }} ScoredNote */
/** @typedef {Line & { index: number, skip: boolean, acc: number, points: number, bonus: number, lyricFactor: number | null, lyricRatio: number | null }} ScoredLine */
/** @typedef {{ score: number, accuracy: number, pitchAccuracy: number, lyricAccuracy: number | null, title: string, stars: number, notesHit: number, notesTotal: number }} Result */

export class Performance {
  /** @param {Chart} chart @param {Difficulty} difficulty @param {Set<number> | null} owned the line indexes this singer
   * sings when friends take turns (null = every line) */
  constructor(chart, difficulty, owned) {
    this.diff = DIFFICULTY[difficulty];
    // Uploaded songs can sit between semitones; sung pitch is compared after removing that offset.
    this.tuning = chart.tuning ?? 0;
    /** @type {ScoredLine[]} */
    this.lines = chart.lines.map((line, index) => ({ ...line, index, skip: !!owned && !owned.has(index), acc: 0, points: 0, bonus: 0, lyricFactor: null, lyricRatio: null }));
    /** @type {ScoredNote[]} */
    this.notes = this.lines.flatMap((line) => line.notes.map((n) => ({
      ...n, line: line.index, skip: line.skip, weight: POINTS_PER_SECOND * n.d * (n.golden ? 2 : 1), frames: 0, credit: 0, spans: [], done: false, acc: 0,
    })));
    this.cursor = 0;
    this.lineCursor = 0;
    this.score = 0;
    this.combo = 0;
    this.multiplier = 1;
    /** @type {ScoredNote | null} the note being sung right now */
    this.current = null;
    /** @type {ScoredLine[]} lines this singer finished since the last look (for the words check) */
    this.finished = [];
  }

  /** @param {number} absDiff */
  credit(absDiff) {
    const { perfect, window } = this.diff;
    if (absDiff <= perfect) return 1;
    return Math.max(0, 1 - (absDiff - perfect) / (window - perfect));
  }

  /** The scoring window skips the very start (consonants, scoops) and end (release) of each note. @param {Note} n */
  static window(n) {
    return [n.t + Math.min(0.07, n.d * 0.25), n.t + n.d - Math.min(0.05, n.d * 0.15)];
  }

  /** @param {number} t song time @param {number | null} sung MIDI, or null when not singing */
  feed(t, sung) {
    this.completeBefore(t);
    const found = this.noteAt(t);
    const n = found?.skip ? null : found;
    this.current = n;
    if (!n) return;
    const [w0, w1] = Performance.window(n);
    if (t < w0 || t > w1) return;
    n.frames++;
    if (sung == null) return;
    const c = this.credit(Math.abs(foldDiff(sung - this.tuning, n.p)));
    n.credit += c;
    if (c >= 0.5) {
      const last = n.spans[n.spans.length - 1];
      if (last && t - last[1] < 0.06) last[1] = t;
      else n.spans.push([t, t]);
    }
  }

  /** The note whose time (plus a little grace) contains t, scanning forward from the cursor. @param {number} t */
  noteAt(t) {
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > t + 0.05) return null;
      if (t <= n.t + n.d + 0.05) return n;
    }
    return null;
  }

  /** @param {number} t */
  completeBefore(t) {
    while (this.cursor < this.notes.length && t >= this.notes[this.cursor].t + this.notes[this.cursor].d + 0.08) this.completeNote(this.notes[this.cursor++]);
    while (this.lineCursor < this.lines.length && t >= this.lines[this.lineCursor].end + 0.12) this.completeLine(this.lines[this.lineCursor++]);
  }

  /** @param {ScoredNote} n */
  completeNote(n) {
    n.done = true;
    if (n.skip) return;
    n.acc = n.frames ? Math.min(1, n.credit / (n.frames * HOLD)) : 0;
    this.combo = n.acc >= HIT_ACCURACY ? this.combo + 1 : 0;
    this.multiplier = Math.min(4, 1 + Math.floor(this.combo / 6));
    const points = Math.round((n.weight * n.acc) / 10) * 10 * this.multiplier;
    this.score += points;
    this.lines[n.line].points += points;
  }

  /** @param {ScoredLine} line */
  completeLine(line) {
    const notes = this.notes.filter((n) => n.line === line.index);
    for (const n of notes) if (!n.done) this.completeNote(n);
    if (line.skip) return;
    const dur = notes.reduce((s, n) => s + n.d, 0);
    line.acc = dur ? notes.reduce((s, n) => s + n.acc * n.d, 0) / dur : 0;
    line.bonus = LINE_BONUS.find(([min]) => line.acc >= min)?.[1] ?? 0;
    this.score += line.bonus;
    this.finished.push(line);
  }

  /** The words check's verdict on a finished line: the share of its words that were heard. Below 40% of the words,
   * the line keeps only part of its points (25% when nothing matched).
   * @param {number} index @param {number} ratio */
  applyLyric(index, ratio) {
    const line = this.lines[index];
    if (!line || line.lyricFactor != null) return;
    line.lyricRatio = ratio;
    line.lyricFactor = ratio >= 0.4 ? 1 : 0.25 + (ratio / 0.4) * 0.75;
    this.score -= Math.round(((line.points + line.bonus) * (1 - line.lyricFactor)) / 10) * 10;
  }

  /** @returns {Result} */
  finish() {
    this.completeBefore(Infinity);
    const lines = this.lines.filter((l) => !l.skip);
    const notes = this.notes.filter((n) => !n.skip);
    const len = (/** @type {ScoredLine} */ l) => l.end - l.start;
    const total = lines.reduce((s, l) => s + len(l), 0);
    const accuracy = total ? lines.reduce((s, l) => s + l.acc * len(l) * (l.lyricFactor ?? 1), 0) / total : 0;
    const checked = lines.filter((l) => l.lyricRatio != null);
    return {
      score: this.score,
      accuracy,
      pitchAccuracy: total ? lines.reduce((s, l) => s + l.acc * len(l), 0) / total : 0,
      lyricAccuracy: checked.length ? checked.reduce((s, l) => s + (l.lyricRatio ?? 0), 0) / checked.length : null,
      title: /** @type {(typeof TITLES)[number]} */ (TITLES.find(([min]) => accuracy >= min))[1],
      stars: Math.max(0, Math.min(5, Math.round(accuracy * 10) / 2)),
      notesHit: notes.filter((x) => x.acc >= HIT_ACCURACY).length,
      notesTotal: notes.length,
    };
  }
}
