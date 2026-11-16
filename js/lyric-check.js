// @ts-check
// Lyric check: transcribe what a singer sang on a line and count how many of the expected words came out.
// Stops players from humming or "la-la-la"-ing their way to a perfect pitch score.

const HOMOPHONES = [
  ['to', 'too', 'two'], ['you', 'u', 'ya', 'yo'], ['i', 'eye', 'ah', 'aye'], ['dear', 'deer', 'here'],
  ['one', 'won', 'a'], ['sun', 'son'], ['high', 'hi'], ['night', 'knight'], ['hour', 'our'],
  ['oh', 'o', 'ooh'], ['hey', 'hay', 'hi'], ['a', 'uh', 'the'], ['star', 'stars'], ['bells', 'bell'],
  ['was', 'is'], ['the', 'a', 'da'], ['twas', 'it', 'was'], ['oer', 'over', 'or'],
];

/** Lower-case words without accents or punctuation, in any script. @param {string} s */
export const words = (s) =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);

/** @param {string} a @param {string} b */
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** @param {string} a @param {string} b */
export const sameWord = (a, b) =>
  a === b ||
  HOMOPHONES.some((g) => g.includes(a) && g.includes(b)) ||
  (Math.max(a.length, b.length) >= 5 ? lev(a, b) <= 2 : Math.max(a.length, b.length) >= 3 && lev(a, b) <= 1);

/** Fraction of expected words found in order in what was heard (longest common subsequence).
 * @param {string} expected @param {string} heard */
export function lyricMatch(expected, heard) {
  const e = words(expected), h = words(heard);
  if (!e.length) return 1;
  const dp = Array.from({ length: e.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 1; i <= e.length; i++)
    for (let j = 1; j <= h.length; j++)
      dp[i][j] = sameWord(e[i - 1], h[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[e.length][h.length] / e.length;
}

/** @typedef {{ status: 'loading', progress: number } | { status: 'ready' } | { status: 'error', message: string }} CheckerState */

export class LyricChecker {
  /** @param {string | null} language null: the English-only model (built-in songs)
   * @param {(state: CheckerState) => void} onState */
  constructor(language, onState) {
    this.language = language;
    this.onState = onState;
    /** @type {CheckerState} */
    this.state = { status: 'loading', progress: 0 };
    this.dead = false;
    /** @type {Map<number, { resolve: (text: string) => void, reject: (err: Error) => void }>} */
    this.pending = new Map();
    this.nextId = 1;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    this.worker = new Worker(new URL('./workers/whisper-worker.js', import.meta.url), { type: 'module' });
    /** @type {Map<string, { loaded: number, total: number }>} */
    const files = new Map();
    /** @type {Promise<void>} */
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          files.set(m.file, m);
          const loaded = [...files.values()].reduce((s, f) => s + f.loaded, 0);
          const total = [...files.values()].reduce((s, f) => s + f.total, 0);
          this.set({ status: 'loading', progress: total ? loaded / total : 0 });
        } else if (m.type === 'ready') {
          this.set({ status: 'ready' });
          resolve();
        } else if (m.type === 'text' || m.type === 'error') {
          const p = this.pending.get(m.id);
          if (!p) {
            if (m.type === 'error') reject(new Error(m.message));
            return;
          }
          this.pending.delete(m.id);
          m.type === 'text' ? p.resolve(m.text) : p.reject(new Error(m.message));
        }
      };
      // The worker died (before or after it was ready): every check waiting on it fails, and the game makes a new one.
      this.worker.onerror = (e) => {
        const err = new Error(e.message || 'The speech model stopped');
        this.dead = true;
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
    });
    this.ready.catch((err) => this.set({ status: 'error', message: err.message }));
    this.worker.postMessage({ type: 'load', language });
  }

  /** @param {CheckerState} state */
  set(state) {
    this.state = state;
    this.onState(state);
  }

  /** Transcriptions run one at a time, in the order lines finish. @param {Float32Array} audio @returns {Promise<string>} */
  transcribe(audio) {
    const run = () => this.ready.then(() => new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
    }));
    /** @type {Promise<string>} */
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  dispose() {
    this.dead = true;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Lyric check stopped'));
    this.pending.clear();
  }
}
