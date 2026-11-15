// The song list: built-in songs (audio and charts in songs/<id>/, art in img/) followed by the
// songs this browser has uploaded (kept in IndexedDB, see import/song-store.js).

export const SONGS = [
  {
    id: 'twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    style: 'Synth-pop lullaby',
    level: 'Easy',
    accent: '#A9BCFF',
    accent2: '#FFE7A3',
  },
  {
    id: 'birthday',
    title: 'Happy Birthday to You',
    style: 'Disco-funk party',
    level: 'Easy',
    accent: '#FF5CD6',
    accent2: '#FFB547',
  },
  {
    id: 'grace',
    title: 'Amazing Grace',
    style: 'Gospel soul ballad',
    level: 'Hard',
    accent: '#FFC46B',
    accent2: '#C2335A',
  },
].map((s) => ({
  ...s,
  cover: `img/cover-${s.id}.jpg`,
  stage: `img/stage-${s.id}.jpg`,
  chart: `songs/${s.id}/chart.json`,
  inst: `songs/${s.id}/inst.mp3`,
  vocals: `songs/${s.id}/vocals.mp3`,
}));

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language' });

// A stored upload as a song entry; its tracks and art are served from object URLs.
export function userSong(rec) {
  return {
    id: rec.id,
    title: rec.title,
    artist: rec.artist,
    style: LANGUAGES.of(rec.chart.language || 'en'),
    level: 'Your song',
    accent: rec.accents[0],
    accent2: rec.accents[1],
    cover: URL.createObjectURL(rec.cover),
    stage: URL.createObjectURL(rec.stage),
    chartData: rec.chart,
    inst: URL.createObjectURL(rec.inst),
    vocals: URL.createObjectURL(rec.vocals),
    user: true,
  };
}

export function releaseSong(song) {
  for (const k of ['cover', 'stage', 'inst', 'vocals']) URL.revokeObjectURL(song[k]);
}

const charts = new Map();
export function loadChart(song) {
  if (song.chartData) return Promise.resolve(song.chartData);
  if (!charts.has(song.id)) {
    const p = fetch(song.chart).then((r) => {
      if (!r.ok) throw new Error(`Chart for ${song.title} is missing (${r.status})`);
      return r.json();
    });
    charts.set(song.id, p);
    p.catch(() => charts.delete(song.id));
  }
  return charts.get(song.id);
}
