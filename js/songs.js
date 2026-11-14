// The song list. Audio and note charts live in songs/<id>/; art in img/.

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

const charts = new Map();
export function loadChart(song) {
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
