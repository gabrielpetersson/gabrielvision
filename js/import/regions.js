// @ts-check
// Finds the stretches of a separated vocal where someone sings, as Whisper-sized pieces (under 28 s).
// Transcribing only these keeps Whisper from inventing words over instrumental parts.

const MAX = 28;

/** @param {Float32Array} rms @param {number} hop seconds per frame @returns {{ start: number, end: number }[]} */
export function vocalRegions(rms, hop) {
  const n = rms.length;
  const db = Array.from(rms, (r) => 20 * Math.log10(r + 1e-9));
  const loud = [...db].sort((a, b) => a - b)[Math.floor(n * 0.95)] ?? -20;
  const on = db.map((d) => d > loud - 30);
  // Runs of activity, bridging short breaths.
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    let j = i;
    while (j + 1 < n && on[j + 1]) j++;
    const last = runs[runs.length - 1];
    if (last && (i - last[1]) * hop < 0.8) last[1] = j;
    else runs.push([i, j]);
    i = j;
  }
  const pad = 0.25;
  const merged = [];
  for (const [a, b] of runs) {
    if ((b - a + 1) * hop < 0.25) continue;
    const start = Math.max(0, a * hop - pad), end = Math.min(n * hop, (b + 1) * hop + pad);
    const last = merged[merged.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  /** @type {{ start: number, end: number }[]} */
  const out = [];
  /** @param {{ start: number, end: number }} r @returns {void} */
  const split = (r) => {
    if (r.end - r.start <= MAX) { out.push(r); return; }
    // Cut at the quietest 200 ms between 12 s and 28 s into the region.
    const w = Math.round(0.2 / hop);
    let best = null, bestDb = Infinity;
    for (let t = r.start + 12; t <= r.start + MAX; t += hop * 2) {
      const i = Math.round(t / hop);
      let s = 0;
      for (let k = i - w; k <= i + w; k++) s += db[Math.max(0, Math.min(n - 1, k))];
      if (s < bestDb) { bestDb = s; best = t; }
    }
    // A level that is not a number (a damaged separation) never wins: cut at the longest piece instead.
    const cut = best ?? r.start + MAX;
    out.push({ start: r.start, end: cut });
    split({ start: cut, end: r.end });
  };
  merged.forEach(split);
  return out;
}
