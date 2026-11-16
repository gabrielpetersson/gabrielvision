// Builds a game chart from a separated vocal: note bars from the pitch track, words placed on those bars,
// syllables per bar, and lyric lines. Pure function (no DOM), so Node tests run it on recorded data.
//
// Data shape in:  pitch { hop, hz[] (0 = not sung), rms[] } (frame i centred at i·hop seconds),
//                 words [{ text, start, end }] from speech recognition, optional pasted lyrics text.
// Data shape out: the chart format of songs/<id>/chart.json, plus `tuning` (semitones the song sits off A440)
//                 and `beatOffset` (seconds to the first beat).

import { hzToMidi } from '../pitch.js';
import { words as normWords, sameWord } from '../lyric-check.js';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

// ---------- Pitch frames ----------
function toFrames({ hz, rms, hop }) {
  const n = hz.length;
  const db = Array.from(rms, (r) => 20 * Math.log10(r + 1e-9));
  const ref = median(db.filter((d) => d > -90).sort((a, b) => a - b).slice(-Math.ceil(n * 0.1)));
  const m = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (hz[i] >= 65 && hz[i] <= 1050 && db[i] >= ref - 30) m[i] = hzToMidi(hz[i]);
  // Bridge one- or two-frame dropouts inside a steady tone, then drop islands shorter than 50 ms.
  for (let i = 1; i < n - 1; i++) {
    if (m[i] != null) continue;
    let j = i;
    while (j < n && m[j] == null && j - i < 3) j++;
    if (j - i <= 2 && m[i - 1] != null && m[j] != null && Math.abs(m[i - 1] - m[j]) < 1) for (let k = i; k < j; k++) m[k] = (m[i - 1] + m[j]) / 2;
  }
  for (let i = 0; i < n; i++) {
    if (m[i] == null) continue;
    let j = i;
    while (j + 1 < n && m[j + 1] != null) j++;
    if (j - i + 1 < 5) for (let k = i; k <= j; k++) m[k] = null;
    i = j;
  }
  // Fix octave slips against the local median, then median-smooth.
  const fixed = m.slice();
  for (let i = 0; i < n; i++) {
    if (m[i] == null) continue;
    const near = [];
    for (let k = Math.max(0, i - 25); k <= Math.min(n - 1, i + 25); k++) if (m[k] != null) near.push(m[k]);
    const med = median(near);
    if (Math.abs(m[i] - med) > 8) fixed[i] = m[i] - 12 * Math.round((m[i] - med) / 12);
  }
  const smooth = fixed.map((v, i) => {
    if (v == null) return null;
    const near = [];
    for (let k = i - 2; k <= i + 2; k++) if (fixed[k] != null) near.push(fixed[k]);
    return median(near);
  });
  return { m: smooth, db, hop, n };
}

// Semitone offset of the whole recording from A440 tuning (circular mean of each frame's cents).
function estimateTuning(m) {
  let x = 0, y = 0;
  for (const v of m) {
    if (v == null) continue;
    const a = 2 * Math.PI * (v - Math.round(v));
    x += Math.cos(a);
    y += Math.sin(a);
  }
  return x || y ? Math.atan2(y, x) / (2 * Math.PI) : 0;
}

// ---------- Note candidates ----------
// Splits each voiced run at syllable dips in loudness and at sustained pitch changes.
function segmentNotes({ m, db, hop, n }, tuning) {
  const notes = [];
  const e = db.map((_, i) => (db[Math.max(0, i - 1)] + db[i] + db[Math.min(n - 1, i + 1)]) / 3);
  for (let i = 0; i < n; i++) {
    if (m[i] == null) continue;
    let j = i;
    while (j + 1 < n && m[j + 1] != null) j++;
    const dips = new Set();
    // Loudness dips of 3 dB or more against both sides (consonants between syllables). This over-splits
    // on purpose: word placement merges same-pitch pieces back when a word has fewer syllables.
    for (let k = i + 4; k <= j - 4; k++) {
      if (!(e[k] <= e[k - 1] && e[k] <= e[k + 1])) continue;
      let l = -Infinity, r = -Infinity;
      for (let q = Math.max(i, k - 15); q < k; q++) l = Math.max(l, e[q]);
      for (let q = k + 1; q <= Math.min(j, k + 15); q++) r = Math.max(r, e[q]);
      if (Math.min(l, r) - e[k] >= 3) dips.add(k);
    }
    // Pitch moves of more than 0.7 semitone held for 60 ms.
    const s = [];
    for (let k = i; k <= j; k++) s[k] = median(m.slice(Math.max(i, k - 4), Math.min(j, k + 4) + 1));
    const cuts = new Set(dips);
    let a = i, level = null, dev = 0, devStart = 0;
    for (let k = i; k <= j; k++) {
      if (dips.has(k)) { a = k; level = null; dev = 0; continue; }
      if (k - a < 5) continue;
      if (level == null) level = median(s.slice(a, k));
      if (Math.abs(s[k] - level) > 0.7) {
        if (!dev) devStart = k;
        if (++dev >= 6) { cuts.add(devStart); a = devStart; level = null; dev = 0; k = devStart; }
      } else dev = 0;
    }
    const bounds = [i, ...[...cuts].sort((x, y) => x - y), j + 1];
    let pieces = [];
    for (let b = 0; b < bounds.length - 1; b++) {
      const [x, y] = [bounds[b], bounds[b + 1] - 1];
      if (y >= x) pieces.push({ a: x, b: y, p: Math.round(median(m.slice(x, y + 1)) - tuning), dip: dips.has(x) });
    }
    // Pieces under 80 ms join their closer-pitched neighbour.
    for (let changed = true; changed && pieces.length > 1; ) {
      changed = false;
      for (let k = 0; k < pieces.length; k++) {
        const pc = pieces[k];
        if ((pc.b - pc.a + 1) * hop >= 0.08) continue;
        const left = pieces[k - 1], right = pieces[k + 1];
        const into = !left ? right : !right ? left : Math.abs(left.p - pc.p) <= Math.abs(right.p - pc.p) ? left : right;
        into.a = Math.min(into.a, pc.a);
        into.b = Math.max(into.b, pc.b);
        pieces.splice(k, 1);
        changed = true;
        break;
      }
    }
    // Neighbours split only by pitch wobble that rounded to the same note become one note again.
    pieces = pieces.reduce((out, pc) => {
      const last = out[out.length - 1];
      if (last && last.p === pc.p && !pc.dip) last.b = pc.b;
      else out.push({ ...pc });
      return out;
    }, []);
    for (const pc of pieces) {
      const d = (pc.b - pc.a + 1) * hop;
      if (d < 0.08) continue;
      const vals = m.slice(pc.a, pc.b + 1).map((v) => v - tuning - pc.p);
      const spread = Math.sqrt(vals.reduce((q, v) => q + v * v, 0) / vals.length);
      notes.push({ t: pc.a * hop - hop / 2, d, p: pc.p, spread });
    }
    i = j;
  }
  // A whole note an octave away from its neighbours (within 4 s) is a pitch-tracking slip.
  for (const n of notes) {
    const near = notes.filter((o) => o !== n && Math.abs(o.t - n.t) < 4).map((o) => o.p);
    if (near.length < 3) continue;
    const med = median(near);
    if (Math.abs(n.p - med) >= 9) n.p -= 12 * Math.round((n.p - med) / 12);
  }
  return notes;
}

// ---------- Simpler bars ----------
// Singers read small wiggles as noise. When the voice leaves a pitch briefly and comes back to it (one or two notes
// a semitone away, or one quick flick of two), those notes take the pitch around them. A step that stays is melody.
function simplify(notes) {
  const out = notes.map((n) => ({ ...n }));
  const touching = (a, b) => b.t - (a.t + a.d) < 0.3;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      for (let j = i + 1; j <= Math.min(i + 2, out.length - 1); j++) {
        const home = out[i - 1].p, away = out.slice(i, j);
        if (out[j].p !== home || !out.slice(i - 1, j + 1).every((n, k, all) => !k || touching(all[k - 1], n))) continue;
        const far = Math.max(...away.map((n) => Math.abs(n.p - home)));
        const long = away.reduce((s, n) => s + n.d, 0);
        if (far && ((far <= 1 && long < 0.45) || (far <= 2 && away.length === 1 && long < 0.18))) {
          for (const n of away) n.p = home;
          changed = true;
        }
      }
    }
  }
  return out;
}

// A line's bars as a singer can follow them. A held-vowel bar ("~") that starts after the word has stopped is a run or
// an echo that sing-along singers skip, so it goes. Bars shorter than MIN_BAR are too quick to hit: one joins the
// bar it touches (its own word first), or grows into the free time after it. A joined bar takes the pitch the voice
// holds across both (the short one is often the slide into a note, so neither bar's own pitch is safe).
const MIN_BAR = 0.15;

function singable(line, heldPitch) {
  const out = line.filter((n, k) => !(n.syl === '~' && k > 0 && n.t - (line[k - 1].t + line[k - 1].d) > 0.1)).map((n) => ({ ...n }));
  const touch = (a, b) => b.t - (a.t + a.d) < 0.06;
  for (let k = 0; k < out.length; k++) {
    const n = out[k], prev = out[k - 1], next = out[k + 1];
    if (n.d >= MIN_BAR) continue;
    const into = prev && !prev.wordEnd && touch(prev, n) ? prev : next && !n.wordEnd && touch(n, next) ? next : prev && touch(prev, n) ? prev : next && touch(n, next) ? next : null;
    if (!into) {
      n.d = +Math.max(n.d, Math.min(MIN_BAR, (next ? next.t - 0.03 : Infinity) - n.t)).toFixed(3);
      continue;
    }
    const [a, b] = into === prev ? [prev, n] : [n, next];
    const syl = a.syl === '~' ? b.syl : b.syl === '~' ? a.syl : a.syl + (a.wordEnd ? ' ' : '') + b.syl;
    const p = heldPitch(a.t, b.t + b.d) ?? (a.d >= b.d ? a.p : b.p);
    out.splice(out.indexOf(a), 2, { ...a, d: +(b.t + b.d - a.t).toFixed(3), p, syl, wordEnd: b.wordEnd, spread: Math.max(a.spread, b.spread) });
    k = -1; // the joined bar can still be short: look again from the start
  }
  return out;
}

// ---------- Words and syllables ----------
const VOWEL = /[aeiouyæøåäöüéèêëáàâíìîïóòôúùûœ]/i;
const DIGRAPHS = ['th', 'sh', 'ch', 'ph', 'wh', 'ck', 'ng', 'qu', 'gh'];

// Splits a word into sung syllables, keeping its original letters and punctuation.
export function syllabify(word, language = 'en') {
  const lower = word.toLowerCase();
  const groups = [];
  for (let i = 0; i < word.length; i++) {
    if (!VOWEL.test(lower[i]) || (lower[i] === 'y' && i === 0)) continue;
    let j = i;
    while (j + 1 < word.length && VOWEL.test(lower[j + 1])) j++;
    groups.push([i, j]);
    i = j;
  }
  // English silent final e ("make", "love"), but not "-le" ("little").
  const letters = lower.replace(/[^\p{L}]/gu, '');
  if (language === 'en' && groups.length > 1 && /[^aeiouyl]e$|[^aeiouy]es$/.test(letters)) {
    const last = groups[groups.length - 1];
    if (last[0] === last[1] && lower[last[0]] === 'e') groups.pop();
  }
  if (groups.length <= 1) return [word];
  const out = [];
  let prev = 0;
  for (let g = 0; g < groups.length - 1; g++) {
    const from = groups[g][1] + 1, to = groups[g + 1][0];
    const cons = to - from;
    const cut = cons <= 1 || (cons === 2 && DIGRAPHS.includes(lower.slice(from, to))) ? from : from + 1;
    out.push(word.slice(prev, cut));
    prev = cut;
  }
  out.push(word.slice(prev));
  return out.filter(Boolean);
}

// Word tokens to place: the pasted lyrics (lines kept) when given, otherwise the recognised words.
// Each token may carry a time prior from recognition.
function tokensFrom(recognised, lyrics) {
  const rec = recognised.map((w) => ({ text: w.text.trim(), norm: normWords(w.text).join(''), start: w.start, end: w.end })).filter((w) => w.norm);
  if (!lyrics?.trim()) return { tokens: rec.map((w) => ({ text: w.text, norm: w.norm, prior: w, line: null })), pasted: false };
  const tokens = [];
  lyrics.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, li) => {
    for (const text of line.split(/\s+/)) {
      const norm = normWords(text).join('');
      if (norm) tokens.push({ text, norm, prior: null, line: li });
    }
  });
  // Global alignment of pasted words to recognised words; matches inherit the recognised timing.
  const A = tokens.length, B = rec.length;
  const score = Array.from({ length: A + 1 }, () => new Float32Array(B + 1));
  const eq = (i, j) => sameWord(tokens[i].norm, rec[j].norm);
  for (let i = 1; i <= A; i++)
    for (let j = 1; j <= B; j++)
      score[i][j] = Math.max(score[i - 1][j], score[i][j - 1], score[i - 1][j - 1] + (eq(i - 1, j - 1) ? 1 : 0));
  for (let i = A, j = B; i > 0 && j > 0; ) {
    if (eq(i - 1, j - 1) && score[i][j] === score[i - 1][j - 1] + 1) {
      tokens[i - 1].prior = rec[j - 1];
      i--; j--;
    } else if (score[i - 1][j] >= score[i][j - 1]) i--;
    else j--;
  }
  return { tokens, pasted: true };
}

// ---------- Placing words on notes ----------
// Monotonic alignment: each word takes a run of consecutive notes (or none); notes may be left out
// (backing vocals, ad-libs). Costs prefer one note per syllable and the recognised timing when known.
function alignWords(tokens, notes, language) {
  const W = tokens.length, N = notes.length, C = 10;
  const syl = tokens.map((t) => syllabify(t.text, language).length);
  const cost = Array.from({ length: W + 1 }, () => new Float64Array(N + 1).fill(Infinity));
  const back = Array.from({ length: W + 1 }, () => new Int8Array(N + 1).fill(-1));
  cost[0][0] = 0;
  const skip = (n) => 0.5 + 3 * n.d;
  // Phrases: runs of notes between breaths (gaps of 0.3 s or more). Whisper rarely puts a word on the
  // wrong side of a breath even when its times drift, so leaving a word's phrase costs extra.
  const phrase = new Int32Array(N);
  for (let k = 1; k < N; k++) phrase[k] = phrase[k - 1] + (notes[k].t - (notes[k - 1].t + notes[k - 1].d) >= 0.3 ? 1 : 0);
  const phraseAt = (t) => {
    let best = 0, dist = Infinity;
    for (let k = 0; k < N; k++) {
      const d = t < notes[k].t ? notes[k].t - t : t > notes[k].t + notes[k].d ? t - notes[k].t - notes[k].d : 0;
      if (d < dist) { dist = d; best = phrase[k]; }
      if (notes[k].t > t + 2) break;
    }
    return best;
  };
  // Whisper stretches a word back over any silence before it, so its end is the trustworthy part.
  const priorStart = tokens.map((t, i) => t.prior && Math.max(t.prior.start, t.prior.end - 0.35 * syl[i] - 0.25));
  const wordPhrase = tokens.map((t) => (t.prior ? phraseAt(t.prior.end - 0.08) : null));
  const place = (i, j, c) => {
    const tok = tokens[i];
    if (c === 0) return 3;
    const first = notes[j], last = notes[j + c - 1];
    // Same-pitch pieces inside a word can be merged, so only distinct pitches count as extra notes.
    let groups = 1;
    for (let k = j + 1; k < j + c; k++) if (notes[k].p !== notes[k - 1].p) groups++;
    let x = c >= syl[i] ? 0.3 * Math.max(0, groups - syl[i]) : 0.8 * (syl[i] - c);
    for (let k = j + 1; k < j + c; k++) {
      const gap = notes[k].t - (notes[k - 1].t + notes[k - 1].d);
      if (gap > 0.35) x += 3 * (gap - 0.35);
      // Big leaps tend to fall between words, not inside one.
      if (Math.abs(notes[k].p - notes[k - 1].p) >= 2) x += 0.15;
    }
    // Whisper's word times on singing drift by up to a second, so they only nudge the placement.
    if (tok.prior) {
      const ds = Math.abs(first.t - priorStart[i]), de = Math.abs(last.t + last.d - tok.prior.end);
      x += Math.min(6, 1.2 * Math.max(0, ds - 0.45) + 0.8 * Math.max(0, de - 0.6));
      if (phrase[j] !== wordPhrase[i] && phrase[j + c - 1] !== wordPhrase[i]) x += 1.5;
    }
    return x;
  };
  for (let i = 0; i <= W; i++)
    for (let j = 0; j <= N; j++) {
      const base = cost[i][j];
      if (!Number.isFinite(base)) continue;
      if (j < N && base + skip(notes[j]) < cost[i][j + 1]) { cost[i][j + 1] = base + skip(notes[j]); back[i][j + 1] = 0; }
      if (i === W) continue;
      for (let c = 0; c <= C && j + c <= N; c++) {
        const v = base + place(i, j, c);
        if (v < cost[i + 1][j + c]) { cost[i + 1][j + c] = v; back[i + 1][j + c] = c + 1; }
      }
    }
  const assign = new Array(W).fill(null);
  for (let i = W, j = N; i > 0 || j > 0; ) {
    const b = back[i][j];
    if (b === 0) { j--; continue; }
    const c = b - 1;
    assign[i - 1] = c ? [j - c, j] : null;
    i--; j -= c;
  }
  return assign;
}

// ---------- Lines ----------
function groupLines(words, pasted) {
  if (pasted) {
    const byLine = new Map();
    for (const w of words) {
      if (!byLine.has(w.line)) byLine.set(w.line, []);
      byLine.get(w.line).push(w);
    }
    return [...byLine.values()];
  }
  // Recognised words: choose the breaks that best combine strong boundaries (breaths, punctuation, a capital where
  // Whisper starts a sung line, held notes) with comfortable line lengths of about four seconds. Sentence cues weigh
  // most: a long note mid-sentence ("Cause all I~~~ need") is not a line end.
  const W = words.length;
  const durs = words.flatMap((w) => w.notes.map((n) => n.d)).sort((a, b) => a - b);
  const med = durs[durs.length >> 1] || 0.3;
  const strength = words.map((w, i) => {
    const next = words[i + 1];
    if (!next) return 0;
    const gap = Math.max(0, next.start - w.end);
    const held = Math.max(0, Math.min(2, (w.notes[w.notes.length - 1].d - med) / med));
    return 3 * Math.min(gap, 1.5) + 0.3 * held + (/[.!?;:]$/.test(w.text) ? 2.5 : /,$/.test(w.text) ? 0.6 : 0) + (/^\p{Lu}/u.test(next.text) && next.text !== 'I' ? 1.5 : 0);
  });
  const lineCost = (j, k) => {
    const dur = words[k].end - words[j].start, n = k - j + 1;
    return ((dur - 4) / 2.5) ** 2 + Math.max(0, n - 12) * 2 + Math.max(0, 2 - dur) * 2 + (n < 3 ? 1.5 : 0);
  };
  const best = new Float64Array(W + 1).fill(Infinity), from = new Int32Array(W + 1);
  best[0] = 0;
  for (let k = 1; k <= W; k++)
    for (let j = Math.max(0, k - 16); j < k; j++) {
      const v = best[j] + lineCost(j, k - 1) - (k < W ? strength[k - 1] : 0);
      if (v < best[k]) { best[k] = v; from[k] = j; }
    }
  const lines = [];
  for (let k = W; k > 0; k = from[k]) lines.unshift(words.slice(from[k], k));
  return lines;
}

// Joins touching neighbours until a word has no more notes than syllables: same-pitch pairs first, then a short
// flourish (under 0.2 s, up to two semitones away) folds into the note next to it, which keeps its pitch.
function mergeWithin(notes, syllables) {
  const out = notes.map((n) => ({ ...n }));
  while (out.length > syllables) {
    let best = -1, bestCost = Infinity;
    for (let k = 1; k < out.length; k++) {
      const [a, b] = [out[k - 1], out[k]];
      const gap = b.t - (a.t + a.d), step = Math.abs(a.p - b.p);
      if (gap >= 0.08 || (step && (step > 2 || Math.min(a.d, b.d) >= 0.2))) continue;
      const cost = step + gap;
      if (cost < bestCost) { bestCost = cost; best = k; }
    }
    if (best < 0) break;
    const a = out[best - 1], b = out[best];
    out.splice(best - 1, 2, { t: a.t, d: b.t + b.d - a.t, p: a.d >= b.d ? a.p : b.p, spread: Math.max(a.spread, b.spread) });
  }
  return out;
}

export function buildChart({ pitch, words, lyrics = '', duration, tempo, title, artist = '', language = 'en' }) {
  const frames = toFrames(pitch);
  const tuning = estimateTuning(frames.m);
  // The note the voice holds most of the time between two song times (null when it is silent there).
  const heldPitch = (t0, t1) => {
    const held = frames.m.slice(Math.max(0, Math.round(t0 / frames.hop)), Math.round(t1 / frames.hop) + 1).filter((v) => v != null).map((v) => Math.round(v - tuning));
    if (!held.length) return null;
    const count = new Map();
    for (const p of held) count.set(p, (count.get(p) || 0) + 1);
    return [...count].sort((x, y) => y[1] - x[1])[0][0];
  };
  const notes = simplify(segmentNotes(frames, tuning));
  const { tokens, pasted } = tokensFrom(words, lyrics);
  const assign = alignWords(tokens, notes, language);

  // Placed words with their notes; a word that got no note rides on the next word's first syllable.
  const placed = [];
  let carry = [];
  tokens.forEach((tok, i) => {
    const span = assign[i];
    if (!span) { carry.push(tok.text); return; }
    const own = mergeWithin(notes.slice(span[0], span[1]), syllabify(tok.text, language).length);
    placed.push({ text: [...carry, tok.text].join(' '), line: tok.line, notes: own, start: own[0].t, end: own[own.length - 1].t + own[own.length - 1].d });
    carry = [];
  });
  if (carry.length && placed.length) placed[placed.length - 1].text += ' ' + carry.join(' ');

  const lines = groupLines(placed, pasted).map((ws) => {
    const out = [];
    for (const w of ws) {
      const parts = w.text.split(' ');
      const head = parts.slice(0, -1).join(' ');
      const sylls = syllabify(parts[parts.length - 1], language);
      if (head) sylls[0] = `${head} ${sylls[0]}`;
      const k = w.notes.length, s = sylls.length;
      // Syllable j goes on note floor(j·k/s); extra notes hold the vowel (melisma, "~").
      const text = new Array(k).fill(null);
      sylls.forEach((sy, j) => {
        const at = Math.min(k - 1, Math.floor((j * k) / s));
        text[at] = text[at] ? text[at] + sy : sy;
      });
      w.notes.forEach((n, j) => out.push({ t: +n.t.toFixed(3), d: +n.d.toFixed(3), p: n.p, syl: text[j] ?? '~', wordEnd: j === k - 1, golden: false, spread: n.spread }));
    }
    const notes = singable(out, heldPitch);
    return { start: notes[0].t, end: +(notes[notes.length - 1].t + notes[notes.length - 1].d).toFixed(3), text: ws.map((w) => w.text).join(' '), notes };
  });

  // Golden notes: the longest steady notes, about one in fourteen.
  const all = lines.flatMap((l) => l.notes);
  all.filter((n) => n.d >= 0.45 && n.spread < 0.35).sort((a, b) => b.d - a.d).slice(0, Math.max(1, Math.round(all.length / 14))).forEach((n) => (n.golden = true));
  all.forEach((n) => delete n.spread);

  return {
    title,
    credit: artist ? `${artist} · your upload` : 'Your upload',
    bpm: tempo.bpm,
    beatsPerBar: 4,
    beatOffset: +tempo.offset.toFixed(3),
    duration: +duration.toFixed(3),
    language,
    tuning: +tuning.toFixed(3),
    lines,
  };
}
