// @ts-check
// The songs this device can play: built-in songs (audio and chart in songs/<id>/, cover in img/), then the ones this
// browser uploaded or got from a friend (kept in IndexedDB, see import/song-store.js).

/** @type {Song[]} */
export const SONGS = [
  { id: 'twinkle', title: 'Twinkle, Twinkle, Little Star' },
  { id: 'birthday', title: 'Happy Birthday to You' },
  { id: 'grace', title: 'Amazing Grace' },
].map(({ id, title }) => ({
  kind: /** @type {const} */ ('builtin'),
  id,
  title,
  cover: `img/cover-${id}.jpg`,
  chartUrl: `songs/${id}/chart.json`,
  inst: `songs/${id}/inst.mp3`,
  vocals: `songs/${id}/vocals.mp3`,
}));

// Every upload's chart says which importer made it (chart.version). Raise this whenever a change to the importer would
// make a song come out differently: uploads made before then offer to be remade each time they are picked.
export const IMPORT_VERSION = 1;
/** @param {Song} song */
export const isOutdated = (song) => song.kind === 'upload' && (song.chart.version ?? 0) < IMPORT_VERSION;

/** A stored upload as a song; its tracks and cover are served from object URLs (see releaseSong).
 * @param {SongRecord} rec @returns {Song} */
export const userSong = (rec) => ({
  kind: 'upload',
  id: rec.id,
  title: rec.title,
  artist: rec.artist,
  accents: rec.accents,
  chart: rec.chart,
  cover: URL.createObjectURL(rec.cover),
  inst: URL.createObjectURL(rec.inst),
  vocals: URL.createObjectURL(rec.vocals),
});

/** @param {Song} song */
export function releaseSong(song) {
  if (song.kind === 'upload') for (const url of [song.cover, song.inst, song.vocals]) URL.revokeObjectURL(url);
}

/** @type {Map<string, Promise<Chart>>} */
const charts = new Map();
/** @param {Song} song @returns {Promise<Chart>} */
export function loadChart(song) {
  if (song.kind === 'upload') return Promise.resolve(song.chart);
  let p = charts.get(song.id);
  if (!p) {
    p = fetch(song.chartUrl).then((r) => {
      if (!r.ok) throw new Error(`Chart for ${song.title} is missing (${r.status})`);
      return r.json();
    });
    charts.set(song.id, p);
    p.catch(() => charts.delete(song.id));
  }
  return p;
}
