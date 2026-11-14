// Lyric check: transcribe what a singer sang on a line and count how many of the expected words came out.
// Stops players from humming or "la-la-la"-ing their way to a perfect pitch score.

const HOMOPHONES = [
  ['to', 'too', 'two'], ['you', 'u', 'ya', 'yo'], ['i', 'eye', 'ah', 'aye'], ['dear', 'deer', 'here'],
  ['one', 'won', 'a'], ['sun', 'son'], ['high', 'hi'], ['night', 'knight'], ['hour', 'our'],
  ['oh', 'o', 'ooh'], ['hey', 'hay', 'hi'], ['a', 'uh', 'the'], ['star', 'stars'], ['bells', 'bell'],
  ['was', 'is'], ['the', 'a', 'da'], ['twas', 'it', 'was'], ['oer', 'over', 'or'],
];

export const words = (s) =>
  s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

const same = (a, b) =>
  a === b ||
  HOMOPHONES.some((g) => g.includes(a) && g.includes(b)) ||
  (Math.max(a.length, b.length) >= 5 ? lev(a, b) <= 2 : Math.max(a.length, b.length) >= 3 && lev(a, b) <= 1);

// Fraction of expected words found in order in what was heard (longest common subsequence).
export function lyricMatch(expected, heard) {
  const e = words(expected), h = words(heard);
  if (!e.length) return 1;
  const dp = Array.from({ length: e.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 1; i <= e.length; i++)
    for (let j = 1; j <= h.length; j++)
      dp[i][j] = same(e[i - 1], h[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[e.length][h.length] / e.length;
}

export class LyricChecker {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.status = 'off';
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
  }

  load() {
    if (this.worker) return this.ready;
    this.status = 'loading';
    this.onStatus?.({ status: 'loading', progress: 0 });
    this.worker = new Worker(new URL('./workers/whisper-worker.js', import.meta.url), { type: 'module' });
    const files = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          files.set(m.file, m);
          const loaded = [...files.values()].reduce((s, f) => s + f.loaded, 0);
          const total = [...files.values()].reduce((s, f) => s + f.total, 0);
          this.onStatus?.({ status: 'loading', progress: total ? loaded / total : 0 });
        } else if (m.type === 'ready') {
          this.status = 'ready';
          this.device = m.device;
          this.onStatus?.({ status: 'ready', device: m.device });
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
      this.worker.onerror = (e) => reject(new Error(e.message || 'Speech model failed to start'));
    });
    this.ready.catch((err) => {
      this.status = 'error';
      this.onStatus?.({ status: 'error', message: err.message });
    });
    this.worker.postMessage({ type: 'load' });
    return this.ready;
  }

  // Transcriptions run one at a time, in the order lines finish.
  transcribe(audio) {
    const run = () =>
      this.ready.then(
        () =>
          new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
          }),
      );
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
