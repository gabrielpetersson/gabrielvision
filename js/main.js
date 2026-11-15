import { AudioEngine } from './audio-engine.js';
import { VoiceInput, listMics, openMic } from './voice-input.js';
import { Performance, DIFFICULTY, foldDiff } from './scoring.js';
import { StageRenderer } from './renderer.js';
import { LyricChecker, lyricMatch } from './lyric-check.js';
import { SONGS, loadChart, userSong, releaseSong } from './songs.js';
import { midiName } from './pitch.js';
import { listUserSongs, getUserSong, saveUserSong, deleteUserSong } from './import/song-store.js';
import { packSong, unpackSong } from './share.js';
import { SERVER } from './import/server.js';
import { Room, inviteLink, roomInLink } from './room.js';
import { startVinyl } from './vinyl.js';

const $ = (id) => document.getElementById(id);
const PLAYER_COLORS = ['#6EF3FF', '#FF77B7', '#B8FF6B', '#FFB547', '#A98BFF', '#FF8A5B'];
// Singing together: one mic each, up to two. Taking turns: one mic passed around, two lines each.
const MAX_PLAYERS = { together: 2, turns: 6 };
const LINES_PER_TURN = 2;
const GUIDE_LEVEL = { off: 0, soft: 0.28, full: 0.9 };
const params = new URLSearchParams(location.search);

// ---------- Settings (per browser) ----------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem('gv:' + key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('gv:' + key, JSON.stringify(value)); } catch {}
  },
};
const settings = Object.assign(
  { players: [{ name: 'Player 1', deviceId: '' }], mode: 'together', difficulty: 'normal', guide: 'soft', lyrics: true, latency: 0, song: 0 },
  store.get('settings', {}),
);
const saveSettings = () => store.set('settings', settings);

// ---------- Global state ----------
let engine = null;
let renderer = null;
let checker = null;
let game = null;
let lastGameOpts = null;
let selIndex = Math.min(settings.song, SONGS.length - 1);
const streams = [];
const monitors = [];
window.__gv = { results: null, status: 'boot' };

function ensureEngine() {
  if (!engine) engine = new AudioEngine();
  return engine.resume().then(() => engine);
}

// One speech model at a time: English-only for built-in songs (language null), the multilingual one
// (already downloaded by the importer) for uploads.
function ensureChecker(language = SONGS[selIndex]?.chartData?.language ?? null) {
  if (checker && checker.language !== language) {
    checker.dispose();
    checker = null;
  }
  if (!checker) {
    checker = new LyricChecker(language, (s) => {
      const el = $('lyrics-status');
      if (s.status === 'loading') el.textContent = `Loading the speech model… ${Math.round((s.progress || 0) * 100)}%`;
      else if (s.status === 'ready') el.textContent = 'Speech model ready. It checks that you sing the words, not just hum.';
      else if (s.status === 'error') el.textContent = `Lyric check unavailable: ${s.message}`;
    });
  }
  checker.load().catch(() => {});
  return checker;
}

// ---------- Screens & stage ----------
function show(name) {
  for (const s of ['title', 'select', 'room', 'game', 'results']) $(`${s}-screen`).hidden = s !== name;
  document.body.dataset.screen = name;
  $('stage').hidden = name !== 'game';
  fx.active = name === 'results';
}

let bgFlip = false;
function setStage(url) {
  const [a, b] = bgFlip ? [$('bgA'), $('bgB')] : [$('bgB'), $('bgA')];
  bgFlip = !bgFlip;
  if (a.dataset.url === url && a.classList.contains('on')) return;
  const img = new Image();
  img.onload = () => {
    a.style.backgroundImage = `url("${url}")`;
    a.dataset.url = url;
    a.classList.add('on');
    b.classList.remove('on');
  };
  img.src = url;
}

function setTheme(song) {
  document.documentElement.style.setProperty('--accent', song.accent);
  document.documentElement.style.setProperty('--accent-2', song.accent2);
}

function toast(msg, kind = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('ok', kind === 'ok');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}

const fmtTime = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

// ---------- Ambient confetti for title and results ----------
const fx = {
  active: true,
  canvas: $('fx'),
  flakes: Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), s: 2 + Math.random() * 4, v: 0.02 + Math.random() * 0.05, r: Math.random() * 6, w: Math.random() * 2 })),
  burst: [],
  tick(dt) {
    const c = this.canvas, g = c.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== Math.round(c.clientWidth * dpr)) { c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.clientWidth, c.clientHeight);
    if (!this.active) return;
    const W = c.clientWidth, H = c.clientHeight;
    for (const f of this.flakes) {
      f.y += f.v * dt; f.r += f.w * dt;
      if (f.y > 1.05) { f.y = -0.05; f.x = Math.random(); }
      g.save();
      g.translate(f.x * W + Math.sin(f.r) * 12, f.y * H);
      g.rotate(f.r);
      g.fillStyle = `rgba(255,214,107,${0.35 + 0.35 * Math.abs(Math.sin(f.r))})`;
      g.fillRect(-f.s / 2, -f.s, f.s, f.s * 2);
      g.restore();
    }
    for (const p of this.burst) {
      p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.w * dt; p.life -= dt * 0.5;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.c; g.fillRect(-3, -6, 6, 12); g.restore();
    }
    this.burst = this.burst.filter((p) => p.life > 0);
  },
  celebrate() {
    const W = this.canvas.clientWidth;
    const colors = ['#FFD66B', '#ffffff', '#FF77B7', '#6EF3FF', '#FFB547'];
    for (let i = 0; i < 160; i++) this.burst.push({ x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: -20, vx: (Math.random() - 0.5) * 300, vy: Math.random() * 200, r: Math.random() * 6, w: (Math.random() - 0.5) * 10, life: 1.6 + Math.random(), c: colors[i % colors.length] });
  },
};
let lastFx = performance.now();
(function fxLoop(t) {
  fx.tick(Math.min(0.05, (t - lastFx) / 1000));
  lastFx = t;
  requestAnimationFrame(fxLoop);
})(lastFx);

// ---------- Title ----------
async function enterSelect() {
  await ensureEngine();
  await loadUserSongs();
  show('select');
  renderSelect();
  if (settings.lyrics) ensureChecker();
  SONGS.forEach((s) => loadChart(s).then(() => s === SONGS[selIndex] && renderSongInfo()).catch(() => {}));
  connectMonitors();
}
$('btn-start').addEventListener('click', () => enterSelect());
$('btn-home').addEventListener('click', () => { stopMonitors(); show('title'); setStage('img/stage-title.jpg'); });

// ---------- Song select ----------
let userSongsLoaded = null;
function loadUserSongs() {
  userSongsLoaded ||= listUserSongs()
    .then((recs) => recs.forEach((r) => SONGS.push(userSong(r))))
    .catch((err) => console.warn('Could not read your saved songs', err));
  return userSongsLoaded;
}

function renderSelect() {
  const car = $('carousel');
  if (car.children.length !== SONGS.length) {
    car.innerHTML = '';
    SONGS.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'cover';
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-label', s.title);
      b.innerHTML = `<img src="${s.cover}" alt="">`;
      b.addEventListener('click', () => (i === selIndex ? startGame({ mode: 'mic' }) : select(i)));
      car.appendChild(b);
    });
  }
  select(selIndex);
  renderSetup();
}

function select(i) {
  selIndex = (i + SONGS.length) % SONGS.length;
  settings.song = selIndex;
  saveSettings();
  const n = SONGS.length;
  [...$('carousel').children].forEach((el, k) => {
    let o = k - selIndex;
    if (o > n / 2) o -= n;
    if (o < -n / 2) o += n;
    el.style.setProperty('--o', o);
    el.style.setProperty('--abs', Math.abs(o));
    el.classList.toggle('sel', o === 0);
    el.setAttribute('aria-selected', o === 0);
    el.toggleAttribute('data-far', Math.abs(o) > 1);
  });
  const song = SONGS[selIndex];
  setTheme(song);
  setStage(song.stage);
  renderSongInfo();
}

function renderSongInfo() {
  const song = SONGS[selIndex];
  $('song-title').textContent = song.title;
  const chips = [`<span class="chip accent">${song.style}</span>`, `<span class="chip">${song.level}</span>`];
  loadChart(song)
    .then((chart) => {
      if (song !== SONGS[selIndex]) return;
      $('song-credit').textContent = chart.credit;
      chips.push(`<span class="chip">${Math.round(chart.bpm)} BPM</span>`, `<span class="chip">${fmtTime(chart.duration)}</span>`);
      $('song-chips').innerHTML = chips.join('');
    })
    .catch(() => {
      $('song-credit').textContent = 'This song is still being recorded.';
      $('song-chips').innerHTML = chips.join('');
    });
  $('song-chips').innerHTML = chips.join('');
  const top = leaderboard(song.id)[0];
  $('song-best').textContent = top ? `Best: ${fmtNum(top.score)} by ${top.name}` : '';
  const remove = $('btn-remove-song');
  remove.hidden = !song.user;
  remove.textContent = 'Remove';
  delete remove.dataset.armed;
}

function renderSetup() {
  const turns = settings.mode === 'turns';
  const rows = $('player-rows');
  rows.innerHTML = '';
  settings.players.forEach((p, i) => {
    // Taking turns shares the first singer's microphone, so only that row picks one.
    const mic = !turns || i === 0;
    const row = document.createElement('div');
    row.className = 'player-row';
    row.style.setProperty('--c', PLAYER_COLORS[i]);
    row.innerHTML = `
      <span class="dot"></span>
      <div class="player-head">
        <input type="text" id="p${i}-name" maxlength="18" aria-label="Singer ${i + 1} name" value="">
        ${i > 0 ? `<button class="icon-btn" type="button" id="p${i}-remove" aria-label="Remove singer ${i + 1}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ''}
      </div>
      ${mic ? `<select id="p${i}-mic" aria-label="${turns ? 'Microphone everyone shares' : `Microphone for singer ${i + 1}`}"><option value="">Default microphone</option></select>
      <div class="meter"><span class="bar"><i id="p${i}-level"></i></span><span class="note" id="p${i}-note">–</span></div>` : ''}`;
    rows.appendChild(row);
    const name = row.querySelector(`#p${i}-name`);
    name.value = p.name;
    name.addEventListener('input', () => { p.name = name.value.trim() || `Player ${i + 1}`; saveSettings(); });
    row.querySelector(`#p${i}-mic`)?.addEventListener('change', (e) => {
      p.deviceId = e.target.value;
      saveSettings();
      connectMonitors();
    });
    row.querySelector(`#p${i}-remove`)?.addEventListener('click', () => {
      settings.players.splice(i, 1);
      saveSettings();
      renderSetup();
      connectMonitors();
    });
  });
  const max = MAX_PLAYERS[settings.mode];
  $('btn-add-player').hidden = settings.players.length >= max;
  $('mode-note').textContent = turns
    ? `Pass one mic around: each singer takes ${LINES_PER_TURN} lines, then the next one is up. Up to ${max} singers.`
    : 'Everyone sings every line, each on their own mic. Up to two singers.';
  fillMicLists();
  for (const [id, key] of [['seg-mode', 'mode'], ['seg-difficulty', 'difficulty'], ['seg-guide', 'guide']]) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-checked', b.dataset.v === settings[key]);
  }
  $('opt-lyrics').checked = settings.lyrics;
}

async function fillMicLists() {
  let mics = [];
  try { mics = await listMics(); } catch {}
  settings.players.forEach((p, i) => {
    const sel = $(`p${i}-mic`);
    if (!sel) return;
    sel.innerHTML = '<option value="">Default microphone</option>' +
      mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, k) => `<option value="${m.deviceId}">${m.label || `Microphone ${k + 1}`}</option>`).join('');
    sel.value = mics.some((m) => m.deviceId === p.deviceId) ? p.deviceId : '';
  });
}

$('btn-add-player').addEventListener('click', () => {
  settings.players.push({ name: `Player ${settings.players.length + 1}`, deviceId: '' });
  saveSettings();
  renderSetup();
  connectMonitors();
});
for (const [id, key] of [['seg-mode', 'mode'], ['seg-difficulty', 'difficulty'], ['seg-guide', 'guide']]) {
  $(id).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    settings[key] = v;
    if (key === 'mode') settings.players.splice(MAX_PLAYERS[v]);
    saveSettings();
    renderSetup();
    if (key === 'mode') connectMonitors();
  });
}
$('opt-lyrics').addEventListener('change', (e) => {
  settings.lyrics = e.target.checked;
  saveSettings();
  if (settings.lyrics) ensureChecker();
  else $('lyrics-status').textContent = 'Off: only your pitch is scored.';
});
$('btn-sing').addEventListener('click', () => startGame({ mode: 'mic' }));
$('btn-demo').addEventListener('click', () => startGame({ mode: 'demo' }));

// Live mic level + note readout on the setup panel, so players can check their mic before singing.
async function connectMonitors() {
  stopMonitors();
  await ensureEngine();
  const mics = settings.mode === 'turns' ? 1 : settings.players.length;
  for (let i = 0; i < mics; i++) {
    try {
      const stream = await getStream(i);
      const m = new VoiceInput(engine, { stream });
      await m.connect();
      monitors.push(m);
    } catch (err) {
      $(`p${i}-note`).textContent = '';
      micError(err);
      return;
    }
  }
  fillMicLists();
  const tick = () => {
    if (!monitors.length || document.body.dataset.screen !== 'select') return;
    monitors.forEach((m, i) => {
      m.drain();
      const lvl = $(`p${i}-level`), note = $(`p${i}-note`);
      if (lvl) lvl.style.width = `${Math.round(m.level * 100)}%`;
      const last = m.history[m.history.length - 1];
      if (note) note.textContent = last?.midi != null ? midiName(last.midi) : '–';
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopMonitors() {
  monitors.splice(0).forEach((m) => m.disconnect());
}

async function getStream(i) {
  const want = settings.players[i]?.deviceId || '';
  const have = streams[i];
  if (have && have.deviceId === want && have.stream.active) return have.stream;
  have?.stream.getTracks().forEach((t) => t.stop());
  const stream = await openMic(want);
  streams[i] = { deviceId: want, stream };
  return stream;
}

function micError(err) {
  if (err?.name === 'NotAllowedError') toast('Microphone blocked. Allow it in the address bar, then reload. You can still watch the demo singer.');
  else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') toast('No microphone found. Plug one in or pick another in the list.');
  else toast(`Microphone error: ${err?.message || err}`);
}

// ---------- Leaderboard (this browser) ----------
function leaderboard(songId) {
  return store.get(`board:${songId}`, []);
}
function addToBoard(songId, entry) {
  const list = [...leaderboard(songId), entry].sort((a, b) => b.score - a.score).slice(0, 8);
  store.set(`board:${songId}`, list);
  return list;
}

// ---------- Game ----------
async function startGame(opts) {
  lastGameOpts = opts;
  stopMonitors();
  // In a room the room says which song; everyone else is on their own device.
  const song = opts.mode === 'room' ? SONGS.find((s) => s.id === opts.song) : SONGS[selIndex];
  show('game');
  setTheme(song);
  setStage(song.stage);
  $('loading').hidden = false;
  $('loading-text').textContent = `Loading ${song.title}…`;
  $('popups').innerHTML = '';
  $('line-now').innerHTML = '';
  $('line-next').textContent = '';
  $('turn-call').hidden = true;
  try {
    await ensureEngine();
    const [chart, inst, vocals] = await Promise.all([loadChart(song), engine.load(song.inst), engine.load(song.vocals)]);
    const difficulty = opts.difficulty || settings.difficulty;
    const inRoom = opts.mode === 'room';
    // Who sings: the room's people (only this device's one sings here), the setup panel's singers with mics,
    // or one recorded singer for the demo and tests.
    const turnsMode = inRoom ? opts.turns : opts.mode === 'mic' ? settings.mode === 'turns' : !!opts.players;
    const names = inRoom ? opts.members.map((m) => m.name)
      : opts.mode === 'mic' ? settings.players.slice(0, MAX_PLAYERS[settings.mode]).map((p) => p.name)
      : opts.players || [opts.mode === 'demo' ? 'Demo singer' : opts.name || 'Test singer'];
    const turns = turnsMode && names.length > 1;
    const local = inRoom ? opts.members.findIndex((m) => m.id === opts.me) : -1;
    const sourceFor = async (i) => opts.mode === 'demo' ? { buffer: vocals, audible: true }
      : opts.mode === 'file' || opts.singer ? { buffer: await engine.load(opts.url || opts.singer), audible: opts.audible }
      : { stream: await getStream(i) };
    const lyricsOn = opts.lyrics ?? settings.lyrics;
    if (lyricsOn) ensureChecker(chart.language ?? null);
    const inputs = [];
    for (let i = 0; i < (inRoom || turns ? 1 : names.length); i++) {
      const input = new VoiceInput(engine, await sourceFor(i), { latency: settings.latency / 1000 });
      await input.connect();
      input.enablePcm(lyricsOn);
      inputs.push({ input, players: [] });
    }
    // Taking turns: lines go out in pairs, round-robin.
    const owners = chart.lines.map((_, i) => (turns ? Math.floor(i / LINES_PER_TURN) % names.length : null));
    const players = names.map((name, i) => {
      const color = PLAYER_COLORS[inRoom ? opts.members[i].color : i];
      // Friends in a room sing on their own devices: here they are a name and the score their device sends.
      if (inRoom && i !== local) return { id: `p${i}`, member: opts.members[i].id, name, color, remote: {}, shown: 0 };
      const group = inputs[inRoom || turns ? 0 : i];
      const owned = turns ? new Set(owners.flatMap((o, li) => (o === i ? [li] : []))) : null;
      const p = { id: `p${i}`, member: inRoom ? opts.me : null, name, color, input: group.input, frames: group.input.history, perf: new Performance(chart, difficulty, owned), shown: 0 };
      group.players.push(p);
      return p;
    });
    const scored = players.filter((p) => p.perf);
    const voices = turns && !inRoom ? [{ id: 'mic', color: players[0].color, frames: inputs[0].input.history, live: null }] : scored;
    if (!renderer) renderer = new StageRenderer($('stage'));
    renderer.setSong(chart, { accent: song.accent, lineColors: turns ? owners.map((o) => players[o].color) : null });
    renderer.resize();
    buildHud(players, turns);
    $('game-title').textContent = song.title;
    const guide = opts.mode === 'demo' || opts.mode === 'file' || opts.singer ? 0 : GUIDE_LEVEL[opts.guide || settings.guide];
    game = { song, chart, players, scored, inputs, voices, turns, owners, opts, difficulty, lyricsOn, inRoom, round: opts.round, pendingChecks: 0, lineShown: -1, ended: false, beatsShown: new Set(), active: -1, sentAt: 0 };
    // A room's song starts at the same moment on every device; someone who arrives late joins mid-song.
    let offset = 0;
    if (inRoom) {
      for (;;) {
        const wait = opts.startAt - room.serverNow();
        if (wait <= 160) { offset = Math.max(0, -wait / 1000 - 0.15); break; }
        $('loading-text').textContent = `Starting in ${Math.ceil(wait / 1000)}…`;
        await new Promise((r) => setTimeout(r, Math.min(250, wait - 150)));
        if (game?.ended) return;
      }
    }
    $('loading').hidden = true;
    const at = engine.play({ inst, vocals, guide, offset });
    inputs.forEach((g) => g.input.startWithSong(at));
    window.__gv.status = 'playing';
    requestAnimationFrame(tick);
  } catch (err) {
    console.error(err);
    $('loading').hidden = true;
    if (err?.name?.endsWith('Error') && /Allowed|NotFound|Overconstrained/.test(err.name)) micError(err);
    else toast(err.message || String(err));
    if (opts.mode === 'room') showRoom();
    else {
      show('select');
      renderSelect();
    }
    window.__gv.status = 'error';
    window.__gv.error = String(err?.message || err);
  }
}

function buildHud(players, turns) {
  $('hud').classList.toggle('turns', turns);
  $('hud').innerHTML = players
    .map((p, i) => `
      <div class="pcard ${i % 2 ? 'p2' : ''}" id="${p.id}-card" style="--c:${p.color}">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="score" id="${p.id}-score">0</span>
        <span class="mult" id="${p.id}-mult" data-m="1">×1</span>
        <span class="streak" id="${p.id}-streak"></span>
      </div>`)
    .join('');
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function nearestNote(perf, t) {
  let best = null, dist = 1.2;
  for (let i = Math.max(0, perf.cursor - 2); i < Math.min(perf.notes.length, perf.cursor + 3); i++) {
    const n = perf.notes[i];
    const d = t < n.t ? n.t - t : t > n.t + n.d ? t - n.t - n.d : 0;
    if (d < dist) { dist = d; best = n; }
  }
  return best;
}

// The line being sung at t, or the next one coming up.
function lineAt(t) {
  const lines = game.chart.lines;
  const i = lines.findIndex((l) => t < l.end + 0.3);
  return i < 0 ? lines.length - 1 : i;
}

function tick() {
  if (!game || game.ended) return;
  if (engine.playing?.pausedAt != null) { requestAnimationFrame(tick); return; }
  const { chart, players } = game;
  const now = engine.heardTime();
  const center = (renderer.lo + renderer.hi) / 2;
  const tuning = chart.tuning ?? 0;

  for (const g of game.inputs) {
    for (const f of g.input.drain()) {
      for (const p of g.players) p.perf.feed(f.t, f.midi);
      // With one shared mic, the comet follows whoever owns the line at that moment.
      const shown = g.players.length > 1 ? players[game.owners[lineAt(f.t)]] : g.players[0];
      f.credit = shown.perf.live.credit;
      if (f.midi == null) f.disp = null;
      else {
        const m = f.midi - tuning;
        const n = shown.perf.live.note || nearestNote(shown.perf, f.t);
        f.disp = n ? n.p + foldDiff(m, n.p) : center + foldDiff(m, center);
      }
    }
  }
  for (const p of game.scored) {
    p.frames = p.input.history;
    p.live = p.perf.live;
    for (const ev of p.perf.events.splice(0)) handleEvent(p, ev);
  }
  // One shared mic in this room: the comet takes the colour of whoever's turn it is.
  if (game.turns && !game.inRoom) {
    const a = players[game.owners[lineAt(now)]];
    Object.assign(game.voices[0], { color: a.color, live: a.perf.live, frames: game.inputs[0].input.history });
  }

  const spb = 60 / chart.bpm, beat = (now - (chart.beatOffset || 0)) / spb;
  const phase = ((beat % 1) + 1) % 1;
  const downbeat = Math.round(beat) % chart.beatsPerBar === 0;
  const pulse = Math.exp(-phase * 5) * (downbeat ? 1 : 0.6);
  document.getElementById('bg').style.setProperty('--pulse', pulse.toFixed(3));
  renderer.draw(now, game.scored, { pulse }, game.voices);
  if (game.inRoom && performance.now() - game.sentAt > 900) {
    game.sentAt = performance.now();
    const me = game.scored[0];
    room?.setLive({ round: game.round, score: me.perf.score, mult: me.perf.multiplier, combo: me.perf.combo });
  }
  updateLyrics(now);
  updateHud(now);
  countdown(now, spb);
  if (game.turns) turnCall(now);
  if (now >= chart.duration + 0.3) endGame();
  else requestAnimationFrame(tick);
}

function handleEvent(p, ev) {
  // One singer at a time when taking turns, so their popups use the first slot.
  const slot = game.turns ? 0 : game.players.indexOf(p);
  if (ev.type === 'note') {
    if (!ev.hit) return;
    const x = renderer.x(ev.note.t + ev.note.d, engine.heardTime());
    const y = renderer.y(ev.note.p);
    renderer.burst(x, y, ev.note.golden ? '#FFD66B' : p.color, ev.note.golden ? 30 : 9, ev.note.golden ? 1.4 : 0.8);
    if (ev.acc > 0.9) renderer.ring(x, y, ev.note.golden ? '#FFD66B' : '#ffffff');
    const m = $(`${p.id}-mult`);
    if (m && m.dataset.m !== String(p.perf.multiplier)) {
      m.classList.add('bump');
      setTimeout(() => m.classList.remove('bump'), 180);
    }
  } else if (ev.type === 'line') {
    popup(ev.rating.key, ev.rating.label, ev.bonus ? `+${fmtNum(ev.bonus)}` : '', slot);
    if (game.lyricsOn) scheduleLyricCheck(p, ev.line);
  } else if (ev.type === 'lyric' && ev.penalty > 0) {
    popup('lyric', 'Sing the words!', `${ev.heard ? `heard “${ev.heard.trim().slice(0, 40)}” · ` : ''}−${fmtNum(ev.penalty)}`, slot, true);
  }
}

function popup(kind, text, small, playerIndex, low) {
  const el = document.createElement('div');
  el.className = `pop ${kind}`;
  el.innerHTML = `${escapeHtml(text)}${small ? `<small>${escapeHtml(small)}</small>` : ''}`;
  const x = renderer.nowX + Math.min(260, renderer.W * 0.18) + playerIndex * Math.min(320, renderer.W * 0.26);
  el.style.left = `${Math.min(renderer.W - 120, x)}px`;
  el.style.top = `${(low ? renderer.bottom + renderer.noteH * 2.4 : renderer.top - renderer.noteH * 2.2)}px`;
  $('popups').appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function scheduleLyricCheck(p, line) {
  if (line.points + line.bonus === 0) return;
  game.pendingChecks++;
  const g = game;
  setTimeout(() => {
    const audio = p.input.audioBetween(line.start - 0.25, line.end + 0.35);
    const done = () => g.pendingChecks--;
    if (!audio || !checker) return done();
    checker
      .transcribe(audio)
      .then((text) => {
        const ratio = lyricMatch(line.text, text);
        p.perf.applyLyric(line.index, ratio, text);
        (window.__gv.lyricLog ||= []).push({ player: p.name, line: line.text, heard: text, ratio });
        if (g === game) for (const ev of p.perf.events.splice(0)) handleEvent(p, ev);
      })
      .catch((err) => console.warn('lyric check failed', err))
      .finally(done);
  }, 500);
}

// "Name" chip in the singer's colour, shown before a line when friends take turns.
const whoChip = (i) => (game.turns ? `<span class="who" style="--c:${game.players[game.owners[i]].color}">${escapeHtml(game.players[game.owners[i]].name)}</span>` : '');

function updateLyrics(now) {
  const lines = game.chart.lines;
  let i = lines.findIndex((l) => now < l.end + 0.3);
  if (i >= 0 && lines[i].start - now > 5) i = -2;
  if (i !== game.lineShown) {
    game.lineShown = i;
    const cur = $('line-now'), next = $('line-next');
    if (i === -1) {
      cur.innerHTML = '';
      next.textContent = '';
    } else if (i === -2) {
      cur.innerHTML = '<span class="instrumental">♪ Instrumental ♪</span>';
      const k = lines.findIndex((l) => l.start > now);
      next.innerHTML = k >= 0 ? whoChip(k) + escapeHtml(lines[k].text) : '';
    } else {
      const line = lines[i];
      cur.innerHTML = whoChip(i) + line.notes
        .map((n, k) => (n.syl === '~' ? '' : `<span class="syl${n.golden ? ' gold' : ''}" data-k="${k}">${escapeHtml(n.syl)}</span>`) + (n.wordEnd ? ' ' : ''))
        .join('');
      game.sylEls = [...cur.querySelectorAll('.syl')].map((el) => ({ el, k: +el.dataset.k, p: -1 }));
      cur.classList.remove('enter');
      void cur.offsetWidth;
      cur.classList.add('enter');
      const nxt = lines[i + 1];
      next.innerHTML = nxt ? (game.turns && game.owners[i + 1] !== game.owners[i] ? whoChip(i + 1) : '') + escapeHtml(nxt.text) : '';
    }
  }
  if (i >= 0 && game.sylEls) {
    const notes = lines[i].notes;
    for (const s of game.sylEls) {
      // A syllable's wipe runs across its note and any melisma notes that follow it.
      let end = s.k;
      while (notes[end + 1]?.syl === '~') end++;
      const t0 = notes[s.k].t, t1 = notes[end].t + notes[end].d;
      const p = Math.max(0, Math.min(1, (now - t0) / (t1 - t0)));
      const q = Math.round(p * 50) / 50;
      if (q !== s.p) { s.p = q; s.el.style.setProperty('--p', q); }
    }
  }
}

// "Ben — you're up": called out in the last seconds before a new singer's first line.
function turnCall(now) {
  const lines = game.chart.lines;
  const k = lines.findIndex((l) => l.start > now);
  const el = $('turn-call');
  const owner = k >= 0 ? game.owners[k] : null;
  const due = k >= 0 && lines[k].start - now < 2.6 && (k === 0 || game.owners[k - 1] !== owner);
  if (!due) {
    if (!el.hidden) { el.hidden = true; delete el.dataset.k; }
    return;
  }
  if (el.dataset.k === String(k)) return;
  const p = game.players[owner];
  el.dataset.k = k;
  el.style.setProperty('--c', p.color);
  el.innerHTML = `${escapeHtml(p.name)}<small>you're up</small>`;
  el.hidden = false;
}

function updateHud(now) {
  const { chart, players } = game;
  const active = game.turns ? game.owners[lineAt(now)] : -1;
  if (active !== game.active) {
    game.active = active;
    players.forEach((p, i) => $(`${p.id}-card`).classList.toggle('active', i === active));
  }
  for (const p of players) {
    const { score = 0, mult = 1, combo = 0 } = p.perf ? { score: p.perf.score, mult: p.perf.multiplier, combo: p.perf.combo } : p.remote;
    p.shown += (score - p.shown) * 0.18;
    if (Math.abs(score - p.shown) < 1) p.shown = score;
    $(`${p.id}-score`).textContent = fmtNum(p.shown);
    const m = $(`${p.id}-mult`);
    m.dataset.m = mult;
    m.textContent = `×${mult}`;
    $(`${p.id}-streak`).textContent = combo >= 3 ? `${combo} note streak` : '';
  }
  $('progress-fill').style.width = `${Math.max(0, Math.min(100, (now / chart.duration) * 100))}%`;
  $('game-time').textContent = `${fmtTime(now)} / ${fmtTime(chart.duration)}`;
}

function countdown(now, spb) {
  const first = game.chart.lines[0]?.notes[0];
  if (!first) return;
  const beatsLeft = Math.ceil((first.t - now) / spb);
  if (beatsLeft >= 1 && beatsLeft <= 3 && !game.beatsShown.has(beatsLeft)) {
    game.beatsShown.add(beatsLeft);
    const el = $('countdown');
    el.hidden = false;
    el.innerHTML = `<span>${beatsLeft}</span>`;
    setTimeout(() => (el.hidden = true), spb * 1000 * 0.95);
  }
}

async function endGame() {
  if (!game || game.ended) return;
  game.ended = true;
  engine.stop();
  $('turn-call').hidden = true;
  const g = game;
  if (g.pendingChecks > 0) {
    $('loading').hidden = false;
    $('loading-text').textContent = 'Checking your lyrics…';
    const t0 = performance.now();
    while (g.pendingChecks > 0 && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 150));
    $('loading').hidden = true;
  }
  g.inputs.forEach(({ input }) => input.disconnect());
  const results = g.scored.map((p) => ({ name: p.name, color: p.color, member: p.member, ...p.perf.finish() }));
  window.__gv.results = results.map(({ bestLine, worstLine, ...r }) => ({ ...r, bestLine: bestLine?.text, worstLine: worstLine?.text }));
  window.__gv.status = 'done';
  if (g.inRoom) {
    const r = results[0];
    room?.send({ result: { round: g.round, score: r.score, accuracy: r.accuracy, title: r.title, stars: r.stars } });
    return showResults(g, results, []);
  }
  let board = leaderboard(g.song.id);
  if (g.opts.mode === 'mic') {
    for (const r of results) board = addToBoard(g.song.id, { name: r.name, score: r.score, acc: r.accuracy, difficulty: g.difficulty, at: Date.now() });
  }
  showResults(g, results, board);
}

function stopGame() {
  if (!game) return;
  game.ended = true;
  engine.stop();
  $('turn-call').hidden = true;
  game.inputs.forEach(({ input }) => input.disconnect());
  game = null;
}

// ---------- Pause ----------
async function pause() {
  if (!game || game.ended) return;
  await engine.pause();
  $('opt-latency').value = settings.latency;
  $('latency-out').textContent = `${settings.latency} ms`;
  $('pause').hidden = false;
}
async function resume() {
  $('pause').hidden = true;
  await engine.unpause();
}
$('btn-pause').addEventListener('click', pause);
$('btn-resume').addEventListener('click', resume);
$('btn-restart').addEventListener('click', async () => {
  const opts = game?.opts;
  $('pause').hidden = true;
  await engine.unpause();
  stopGame();
  startGame(opts || { mode: 'mic' });
});
$('btn-quit').addEventListener('click', async () => {
  $('pause').hidden = true;
  await engine.unpause();
  const inRoom = game?.inRoom;
  stopGame();
  inRoom ? showRoom() : enterSelect();
});
$('opt-latency').addEventListener('input', (e) => {
  settings.latency = +e.target.value;
  $('latency-out').textContent = `${settings.latency} ms`;
  saveSettings();
  game?.inputs.forEach(({ input }) => (input.latency = settings.latency / 1000));
});

// ---------- Results ----------
function stars(n) {
  return `<span class="stars" aria-label="${n} of 5 stars">${[1, 2, 3, 4, 5].map((k) => `<i class="${n >= k ? 'on' : n >= k - 0.5 ? 'half' : ''}"></i>`).join('')}</span>`;
}
const pct = (x) => `${Math.round(x * 100)}%`;

function showResults(g, results, board) {
  show('results');
  lastResults = { g, results };
  $('res-kicker').textContent = `${DIFFICULTY[g.difficulty].label}${g.turns ? ' · Taking turns' : ''} · Results`;
  $('res-title').textContent = g.song.title;
  $('btn-back-room').hidden = !g.inRoom;
  $('btn-again').hidden = g.inRoom;
  $('btn-songs').hidden = g.inRoom;
  $('leaderboard').hidden = g.inRoom;
  delete $('ranking').dataset.key;
  renderRanking(g, results);
  if (!g.inRoom) {
    const names = new Set(results.map((r) => r.name));
    $('leaderboard').innerHTML = board.length
      ? `<h4>Top scores on this device</h4><ol>${board.slice(0, 5).map((e) => `<li class="${names.has(e.name) && results.some((r) => r.score === e.score) ? 'me' : ''}"><b>${escapeHtml(e.name)}</b><span>${fmtNum(e.score)}</span></li>`).join('')}</ol>`
      : '<h4>Top scores on this device</h4><p class="field-note">Sing with your mic to get on the board.</p>';
  }
  renderCoach(results, 0);
  if (Math.max(...results.map((r) => r.accuracy)) >= 0.65) setTimeout(() => fx.celebrate(), 400);
}

// In a room, friends' scores arrive from their devices as they finish; the list fills in as they do.
let lastResults = null;
function renderRanking(g, results) {
  const entries = [...results];
  if (g.inRoom) {
    for (const p of g.players) {
      if (p.perf) continue;
      const r = room?.view?.members.find((m) => m.id === p.member)?.result;
      entries.push(r?.round === g.round ? { name: p.name, color: p.color, ...r } : { name: p.name, color: p.color, score: p.remote.score || 0, pending: true });
    }
  }
  const ranked = entries.sort((a, b) => b.score - a.score);
  const key = ranked.map((r) => `${r.name}:${r.score}:${!!r.pending}`).join('|');
  if (key === $('ranking').dataset.key) return;
  const first = !$('ranking').dataset.key;
  $('ranking').dataset.key = key;
  $('ranking').innerHTML = ranked
    .map((r, i) => `
      <li class="rank-row ${i === 0 && !r.pending ? 'win' : ''}" style="--c:${r.color}; animation-delay:${first ? i * 0.25 : 0}s">
        <span class="rank-num">${i + 1}</span>
        <span class="rank-name"><b>${escapeHtml(r.name)}${i === 0 && ranked.length > 1 && !r.pending ? '<span class="douze">12 points</span>' : ''}</b>
          <span>${r.pending ? 'Still singing…' : `<span class="title-badge">${r.title}</span> · ${stars(r.stars)}`}</span></span>
        <span class="rank-score"><b data-count="${r.score}">${first ? 0 : fmtNum(r.score)}</b><span>${r.pending ? '' : `${pct(r.accuracy)} accuracy`}</span></span>
      </li>`)
    .join('');
  if (first) for (const el of $('ranking').querySelectorAll('[data-count]')) countUp(el, +el.dataset.count);
}

function countUp(el, target) {
  const t0 = performance.now(), dur = 1400;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = fmtNum(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function coachTips(r) {
  const tips = [];
  if (r.notesTotal && r.pitchAccuracy < 0.15) tips.push('We barely heard you. Move closer to the mic or pick the right one on the song screen.');
  if (r.centsMean != null && r.centsMean < -15) tips.push(`You sit about ${Math.round(-r.centsMean)} cents flat. Aim at the top of each note and keep your breath moving on long notes.`);
  if (r.centsMean != null && r.centsMean > 15) tips.push(`You drift about ${Math.round(r.centsMean)} cents sharp. Relax your throat and don't push the high notes.`);
  if (r.lateMs != null && r.lateMs > 150) tips.push(`You come in about ${Math.round(r.lateMs)} ms late. Breathe before the line, then start the vowel on the beat. If you were on time, raise Mic delay in the pause menu.`);
  if (r.lateMs != null && r.lateMs < -80) tips.push(`You jump in about ${Math.round(-r.lateMs)} ms early. Wait for the beat before each line.`);
  if (r.centsSpread != null && r.centsSpread > 38) tips.push('Your pitch wobbles inside notes. Hold long notes steady before adding vibrato.');
  if (r.lyricAccuracy != null && r.lyricAccuracy < 0.6) tips.push('The lyric check missed many words. Open your mouth wider and land the consonants.');
  if (r.otherOctave > 0.5) tips.push('You sang most of it an octave away from the written notes. That counts, every octave scores.');
  if (r.worstLine && r.worstLine.acc < 0.75) tips.push(`Practice “${r.worstLine.text}”: you scored ${pct(r.worstLine.acc)} there.`);
  if (r.accuracy >= 0.88) tips.push('Ready for more? Hard shrinks the target to under a semitone.');
  if (!tips.length) tips.push('Solid run. Hit the golden notes for double points and keep your streak alive for ×4.');
  return tips.slice(0, 4);
}

function renderCoach(results, idx) {
  const r = results[idx];
  const tuning = r.centsMean == null ? '–' : Math.abs(r.centsMean) < 6 ? 'In tune' : `${Math.abs(Math.round(r.centsMean))}¢ ${r.centsMean < 0 ? 'flat' : 'sharp'}`;
  const gaugeX = r.centsMean == null ? 50 : Math.max(2, Math.min(98, 50 + r.centsMean));
  const timing = r.lateMs == null ? '–' : Math.abs(r.lateMs) < 60 ? 'On the beat' : `${Math.abs(Math.round(r.lateMs))} ms ${r.lateMs > 0 ? 'late' : 'early'}`;
  const range = r.range ? `${midiName(r.range.lo)} – ${midiName(r.range.hi)}` : '–';
  $('coach').innerHTML = `
    ${results.length > 1 ? `<div class="coach-tabs">${results.map((x, i) => `<button type="button" class="btn-ghost" data-i="${i}" ${i === idx ? 'aria-pressed="true" style="border-color:' + x.color + '"' : ''}>${escapeHtml(x.name)}</button>`).join('')}</div>` : ''}
    <h4>Vocal coach</h4>
    <div class="coach-head">
      <div class="ring" style="--v:${r.pitchAccuracy.toFixed(3)}; --c:${r.color}"><b>${pct(r.pitchAccuracy)}</b></div>
      <div><strong>${escapeHtml(r.name)}, ${r.title.toLowerCase()} performance</strong>
        <p>Pitch accuracy across every note${r.lyricAccuracy != null ? `, with ${pct(r.lyricAccuracy)} of the words recognised` : ''}.</p></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><span>Notes hit</span><b>${r.notesHit} / ${r.notesTotal}</b><em>Golden ${r.goldenHit} / ${r.goldenTotal} · best streak ${r.bestCombo}</em></div>
      <div class="stat"><span>Tuning</span><b>${tuning}</b><div class="gauge" title="flat ← → sharp"><i style="left:${gaugeX}%"></i></div></div>
      <div class="stat"><span>Timing</span><b>${timing}</b><em>Median start of each note</em></div>
      <div class="stat"><span>Range today</span><b>${range}</b><em>${r.otherOctave > 0.5 ? 'Mostly an octave off the chart' : 'Notes you held in tune'}</em></div>
    </div>
    <div><h4>Tips for next time</h4><ul class="tips">${coachTips(r).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>
    <div><h4>Line by line</h4><ol class="line-list">${r.lines.map((l) => `<li><span>${escapeHtml(l.text)}</span><span>${l.lyric != null && l.lyric < 0.5 ? '<span class="tag words">words</span> ' : ''}<span class="tag ${l.rating}">${pct(l.acc)}</span></span></li>`).join('')}</ol></div>`;
  for (const b of $('coach').querySelectorAll('[data-i]')) b.addEventListener('click', () => renderCoach(results, +b.dataset.i));
}

$('btn-again').addEventListener('click', () => startGame(lastOpts()));
$('btn-songs').addEventListener('click', () => enterSelect());
const lastOpts = () => lastGameOpts || { mode: 'mic' };

// ---------- Sing with friends: rooms ----------
// Everyone opens the invite link on their own device. Anyone picks a song, the host starts; the song starts on every
// device at the same moment, each person sings into their own mic, and scores travel through the room service.
// Songs people uploaded are listed for the whole room; a picked one goes from someone who has it to everyone who
// doesn't, and stays in their library afterwards.
let room = null;
let roomMonitor = null;
let roomPlayed = 0;
const transfers = new Map(); // song id -> { dir: 'send' | 'get', error? } for transfers this device runs
const myName = () => settings.players[0]?.name || 'Singer';
const haveSong = (id) => SONGS.some((s) => s.id === id);
const builtIn = (id) => SONGS.some((s) => s.id === id && !s.user);
const myLibrary = () => SONGS.filter((s) => s.user).map((s) => ({ id: s.id, title: s.title, artist: s.artist, duration: s.chartData.duration, language: s.chartData.language, accents: [s.accent, s.accent2] }));
const sendLibrary = () => room?.send({ library: myLibrary() });

// Built-in songs, then every song someone here has, each with who has it.
function roomCatalog(view) {
  const lib = new Map();
  for (const s of SONGS.filter((x) => x.user)) lib.set(s.id, { id: s.id, title: s.title, accents: [s.accent, s.accent2], cover: s.cover, holders: [] });
  for (const m of view.members.filter((x) => x.here)) {
    for (const e of m.library) {
      if (!lib.has(e.id)) lib.set(e.id, { ...e, holders: [] });
      lib.get(e.id).holders.push(m);
    }
  }
  return [...SONGS.filter((x) => !x.user).map((s) => ({ id: s.id, title: s.title, cover: s.cover, builtIn: true })), ...lib.values()];
}

// Who in the room has the picked song, and who still needs it.
function songHolders(view, id) {
  const here = view.members.filter((m) => m.here);
  const has = (m) => (m.id === view.me ? haveSong(id) : builtIn(id) || m.library.some((e) => e.id === id));
  return { holders: here.filter(has), missing: here.filter((m) => !has(m)) };
}

// The first person here who has the picked song sends it once; everyone without it fetches it when it's sent.
function runTransfers(view) {
  const id = view.room.song;
  if (builtIn(id) || transfers.has(id)) return;
  const { holders, missing } = songHolders(view, id);
  if (!missing.length || !holders.length) return;
  if (haveSong(id)) {
    if (holders[0].id === view.me && !room.live.sent?.[id]) sendSong(id);
  } else {
    const sender = holders.find((m) => m.live?.sent?.[id]);
    if (sender) getSong(id, sender);
  }
}

async function sendSong(id) {
  const t = { dir: 'send' };
  transfers.set(id, t);
  const xfer = (p) => room?.setLive({ xfer: { id, dir: 'send', p: Math.round(p * 100) / 100 } });
  try {
    xfer(0);
    const blob = await packSong(await getUserSong(id), (p) => xfer(p * 0.4));
    await room.upload(id, blob, (p) => xfer(0.4 + p * 0.6));
    room?.setLive({ sent: { ...room.live.sent, [id]: blob.size }, xfer: null });
    transfers.delete(id);
  } catch (err) {
    t.error = err.message || String(err);
    room?.setLive({ xfer: null });
  }
  renderRoom();
}

async function getSong(id, sender) {
  const t = { dir: 'get', from: sender.name };
  transfers.set(id, t);
  const xfer = (p) => {
    t.p = p;
    room?.setLive({ xfer: { id, dir: 'get', p: Math.round(p * 100) / 100 } });
    if (document.body.dataset.screen === 'room') renderRoomStatus();
  };
  try {
    xfer(0);
    const rec = await unpackSong(await room.download(id, sender.live.sent[id], xfer), sender.name);
    await saveUserSong(rec);
    SONGS.push(userSong(rec));
    sendLibrary();
    room?.setLive({ xfer: null });
    transfers.delete(id);
  } catch (err) {
    t.error = err.message || String(err);
    room?.setLive({ xfer: null });
  }
  renderRoom();
}

async function enterRoom(code) {
  await ensureEngine();
  room?.leave();
  room = new Room(onRoomUpdate);
  roomPlayed = 0;
  showRoom();
  $('room-status').textContent = code ? 'Joining…' : 'Making your room…';
  try {
    await loadUserSongs();
    const joined = await room.enter(code, myName());
    sendLibrary();
    history.replaceState(null, '', `#room=${joined}`);
    window.__gv.room = joined;
    // Don't drop into a song that has been playing for a while; wait for the next one.
    const r = room.view.room;
    if (r.startAt && room.serverNow() - r.startAt > 15000) roomPlayed = r.round;
  } catch (err) {
    toast(err.message || String(err));
    leaveRoom();
  }
}

function showRoom() {
  show('room');
  setStage('img/stage-title.jpg');
  $('room-name').value = myName();
  renderRoom();
  connectRoomMic();
}

function leaveRoom() {
  room?.leave();
  room = null;
  roomMonitor?.disconnect();
  roomMonitor = null;
  history.replaceState(null, '', location.pathname + location.search);
  show('title');
  setStage('img/stage-title.jpg');
}

function onRoomUpdate(view) {
  if (!view) return;
  const r = view.room;
  // The host started a new song: play it (also from the results of the last one).
  if (r.round > roomPlayed && r.startAt && room.serverNow() - r.startAt < 15000 && !(game && !game.ended)) {
    roomPlayed = r.round;
    // Someone who arrived without the song sits this one out and gets it for the next.
    if (!haveSong(r.song)) return renderRoom();
    roomMonitor?.disconnect();
    roomMonitor = null;
    const members = r.roster.map((id) => view.members.find((m) => m.id === id)).filter(Boolean);
    startGame({ mode: 'room', song: r.song, turns: r.mode === 'turns', difficulty: r.difficulty, members, me: view.me, round: r.round, startAt: r.startAt, singer: roomSinger });
    return;
  }
  if (game && !game.ended && game.inRoom) {
    for (const p of game.players) if (!p.perf) p.remote = view.members.find((m) => m.id === p.member)?.live?.round === game.round ? view.members.find((m) => m.id === p.member).live : p.remote;
  }
  if (document.body.dataset.screen === 'results' && lastResults?.g.inRoom) renderRanking(lastResults.g, lastResults.results);
  if (!(game && !game.ended)) runTransfers(view);
  if (document.body.dataset.screen === 'room') renderRoom();
}

function renderRoom() {
  const view = room?.view;
  $('room-code').innerHTML = view ? `Room <b>${view.room.code}</b>` : '';
  if (!view) return;
  const { members, me, isHost } = view;
  const r = view.room;
  const people = members
    .map((m) => `<li class="${m.here ? '' : 'away'}" style="--c:${PLAYER_COLORS[m.color]}"><span class="dot"></span><span>${escapeHtml(m.name)}</span><em>${[m.id === r.host ? 'host' : '', m.id === me ? 'you' : '', m.here ? '' : 'away'].filter(Boolean).join(' · ')}</em></li>`)
    .join('');
  // Rebuilt only when it changes, so each name's entrance plays once.
  if ($('room-people').dataset.html !== people) $('room-people').innerHTML = $('room-people').dataset.html = people;
  const list = $('room-songs');
  const tiles = roomCatalog(view);
  const key = tiles.map((t) => `${t.id}:${haveSong(t.id)}:${(t.holders || []).map((m) => m.id).join('+')}`).join('|');
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = tiles.map((t) => {
      const label = t.builtIn ? '' : haveSong(t.id) ? 'You have it' : t.holders.length ? `From ${t.holders[0].name}${t.holders.length > 1 ? ` +${t.holders.length - 1}` : ''}` : '';
      const art = haveSong(t.id) ? `<img src="${SONGS.find((x) => x.id === t.id).cover}" alt="">`
        : `<span class="tile-art" style="--a:${t.accents[0]};--b:${t.accents[1]}">${escapeHtml(t.title)}</span>`;
      return `<button type="button" class="song-tile" role="radio" data-id="${t.id}">${art}<span>${escapeHtml(t.title)}</span>${label ? `<em>${escapeHtml(label)}</em>` : ''}</button>`;
    }).join('');
  }
  for (const b of list.children) b.setAttribute('aria-checked', b.dataset.id === r.song);
  const song = SONGS.find((s) => s.id === r.song);
  if (song) setTheme(song);
  for (const b of $('room-mode').querySelectorAll('button')) {
    b.setAttribute('aria-checked', b.dataset.v === r.mode);
    b.disabled = !isHost;
  }
  $('room-mode-note').textContent = r.mode === 'turns'
    ? `Each singer takes ${LINES_PER_TURN} lines, in the order on the list, then the next one is up.`
    : 'Everyone sings every line. Highest score wins.';
  $('btn-room-start').hidden = !isHost;
  renderRoomStatus();
}

// The line under Start: what the room is waiting for, including songs on their way between friends.
function renderRoomStatus() {
  const view = room?.view;
  if (!view) return;
  const { members, isHost } = view;
  const r = view.room;
  const here = members.filter((m) => m.here);
  const title = roomCatalog(view).find((t) => t.id === r.song)?.title || 'the song';
  const { holders, missing } = songHolders(view, r.song);
  const mine = transfers.get(r.song);
  const pct = (p) => `${Math.round((p || 0) * 100)}%`;
  const sending = holders.find((m) => m.live?.xfer?.id === r.song && m.live.xfer.dir === 'send');
  let status;
  if (room.error) status = `Connection trouble: ${room.error.message}`;
  else if (mine?.error) status = `“${title}” didn't arrive: ${mine.error}`;
  else if (missing.length && !holders.length) status = `Nobody here has “${title}” any more. Pick another song.`;
  else if (mine?.dir === 'get') status = `Getting “${title}” from ${mine.from}… ${pct(mine.p)}`;
  else if (missing.length && sending) status = sending.id === view.me ? `Sending “${title}” to the room… ${pct(sending.live.xfer.p)}` : `${sending.name} is sending “${title}”… ${pct(sending.live.xfer.p)}`;
  else if (missing.some((m) => m.id === view.me)) status = `Waiting for ${holders[0].name} to send “${title}”.`;
  else if (missing.length) {
    const getting = missing.find((m) => m.live?.xfer?.id === r.song);
    status = `Waiting for ${missing.map((m) => m.name).join(', ')} to get “${title}”${getting ? ` (${pct(getting.live.xfer.p)})` : ''}.`;
  } else if (isHost) status = here.length < 2 ? 'Send the link to your friends. You can also start alone.' : `${here.length} singers ready.`;
  else status = `Waiting for ${members.find((m) => m.id === r.host)?.name || 'the host'} to start the song.`;
  $('room-status').textContent = status;
  $('btn-room-start').disabled = missing.length > 0;
}

async function connectRoomMic() {
  roomMonitor?.disconnect();
  roomMonitor = null;
  try {
    await ensureEngine();
    roomMonitor = new VoiceInput(engine, { stream: await getStream(0) });
    await roomMonitor.connect();
  } catch (err) {
    micError(err);
    return;
  }
  let mics = [];
  try { mics = await listMics(); } catch {}
  const sel = $('room-mic');
  sel.innerHTML = '<option value="">Default microphone</option>' +
    mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, k) => `<option value="${m.deviceId}">${m.label || `Microphone ${k + 1}`}</option>`).join('');
  sel.value = mics.some((m) => m.deviceId === settings.players[0].deviceId) ? settings.players[0].deviceId : '';
  const m = roomMonitor;
  const tick = () => {
    if (m !== roomMonitor || document.body.dataset.screen !== 'room') return;
    m.drain();
    $('room-level').style.width = `${Math.round(m.level * 100)}%`;
    const last = m.history[m.history.length - 1];
    $('room-note').textContent = last?.midi != null ? midiName(last.midi) : '–';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

$('btn-friends').addEventListener('click', () => enterRoom(roomInLink() || null));
$('btn-room-home').addEventListener('click', leaveRoom);
$('btn-back-room').addEventListener('click', showRoom);
$('btn-invite').addEventListener('click', async () => {
  if (!room?.view) return;
  const link = inviteLink(room.view.room.code);
  let copied = false;
  try { await navigator.clipboard.writeText(link); copied = true; } catch {}
  const btn = $('btn-invite');
  $('invite-label').textContent = copied ? 'Link copied! Send it to your friends' : link;
  btn.classList.toggle('done', copied);
  clearTimeout(btn.timer);
  btn.timer = setTimeout(() => { $('invite-label').textContent = 'Copy invite link'; btn.classList.remove('done'); }, 2500);
});
$('room-name').addEventListener('input', (e) => {
  settings.players[0].name = e.target.value.trim() || 'Singer';
  saveSettings();
  room?.send({ name: settings.players[0].name });
});
$('room-mic').addEventListener('change', (e) => {
  settings.players[0].deviceId = e.target.value;
  saveSettings();
  connectRoomMic();
});
$('room-songs').addEventListener('click', (e) => {
  const id = e.target.closest('.song-tile')?.dataset.id;
  if (id && room?.view) room.act('set', { song: id }).catch((err) => toast(err.message));
});
$('room-mode').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (v && room?.view?.isHost) room.act('set', { mode: v }).catch((err) => toast(err.message));
});
$('btn-room-start').addEventListener('click', () => room?.act('start', {}).catch((err) => toast(err.message)));

// ---------- Add your own song ----------
const STEPS = [
  { key: 'read', label: 'Reading the file' },
  { key: 'separate', label: 'Separating the voice from the music' },
  { key: 'lyrics', label: 'Listening for the words' },
  { key: 'notes', label: 'Finding the notes' },
  { key: 'save', label: 'Saving it on this device' },
];
// Raw pipeline stages → the step they belong to, with a note while that part runs.
const STAGE = {
  read: ['read'], download: ['separate', 'Loading the voice model (a 67 MB download the first time)'], separate: ['separate'],
  upload: ['separate', 'Uploading to our server'], server: ['separate', 'Our server is separating the voice and writing down the words'],
  pitch: ['lyrics', 'Tracking the melody'], 'lyrics-model': ['lyrics', 'Loading the speech model (a 77 MB download the first time)'],
  words: ['lyrics', 'Writing down the words'], lyrics: ['lyrics'], notes: ['notes'], save: ['save'],
};
let importFile = null;
let importAbort = null;

async function openImport(file) {
  $('import').hidden = false;
  $('import-pick').hidden = false;
  $('import-run').hidden = true;
  setImportFile(file || null);
  const { gpuDevice } = await import('./import/importer.js');
  const gpu = await gpuDevice();
  $('import-where').textContent = gpu
    ? 'Runs on this device, so your song never leaves it. The first time it downloads about 150 MB of models.'
    : SERVER
      ? "This browser can't use the graphics chip, so our server does the heavy part. Your file is deleted right after."
      : "This browser can't use the graphics chip, so it runs slowly here: a few minutes per minute of song.";
}

function setImportFile(file) {
  importFile = file;
  $('drop').classList.toggle('has-file', !!file);
  const touch = matchMedia('(pointer: coarse)').matches;
  $('drop-title').textContent = file ? file.name : touch ? 'Tap to choose a song' : 'Drop a song here';
  $('drop-note').textContent = file ? `${(file.size / 1e6).toFixed(1)} MB · ${touch ? 'tap' : 'click'} to pick another` : `${touch ? 'Any' : 'or click to choose one. Any'} audio or video file with singing.`;
  $('import-go').disabled = !file;
}

function closeImport() {
  importAbort?.abort();
  $('import').hidden = true;
}

function renderSteps(current, progress, note) {
  const at = STEPS.findIndex((s) => s.key === current);
  $('import-steps').innerHTML = STEPS.map((s, i) => {
    const state = i < at ? 'done' : i === at ? 'on' : '';
    const pct = i === at && progress != null ? Math.round(progress * 100) : null;
    return `<li class="${state}"><span class="ico"></span><span>${s.label}</span><span class="pct">${pct != null ? `${pct}%` : ''}</span>
      ${i === at && note ? `<span class="sub">${escapeHtml(note)}</span>` : ''}
      ${i === at && pct != null ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}</li>`;
  }).join('');
}

async function runImport() {
  const file = importFile;
  if (!file) return;
  $('import-pick').hidden = true;
  $('import-run').hidden = false;
  $('import-file-label').textContent = file.name;
  $('import-run-note').textContent = '';
  importAbort = new AbortController();
  const signal = importAbort.signal;
  let last = 0;
  const stage = (name, p) => {
    const [step, note] = STAGE[name] || [name];
    const now = performance.now();
    if (p > 0 && p < 1 && now - last < 120) return;
    last = now;
    renderSteps(step, p, note);
  };
  renderSteps('read', 0);
  const t0 = performance.now();
  try {
    const { importSong } = await import('./import/importer.js');
    const rec = await importSong(file, { lyrics: $('import-lyrics').value, server: SERVER, signal, stage });
    renderSteps('save', null);
    await saveUserSong(rec);
    const song = userSong(rec);
    SONGS.push(song);
    sendLibrary();
    renderSelect();
    select(SONGS.length - 1);
    $('import').hidden = true;
    $('import-lyrics').value = '';
    const secs = Math.round((performance.now() - t0) / 1000);
    toast(`“${rec.title}” is ready: ${rec.chart.lines.length} lines found in ${secs} s. Press Sing.`, 'ok');
    window.__gv.imported = { id: rec.id, lines: rec.chart.lines.length, secs, where: rec.where, language: rec.chart.language };
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    $('import-run-note').textContent = `That didn't work: ${err.message || err}`;
    $('import-cancel').textContent = 'Back';
    window.__gv.importError = String(err?.message || err);
  } finally {
    importAbort = null;
  }
}

$('btn-add-song').addEventListener('click', () => openImport());
$('import-close').addEventListener('click', closeImport);
$('import-cancel').addEventListener('click', () => {
  importAbort?.abort();
  $('import-cancel').textContent = 'Cancel';
  $('import-pick').hidden = false;
  $('import-run').hidden = true;
});
$('import-file').addEventListener('change', (e) => e.target.files[0] && setImportFile(e.target.files[0]));
$('import-go').addEventListener('click', runImport);
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    if (document.body.dataset.screen !== 'select' || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    $('drop').classList.add('over');
  });
}
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
document.addEventListener('drop', (e) => {
  if (document.body.dataset.screen !== 'select') return;
  e.preventDefault();
  $('drop').classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (!file || importAbort) return;
  if ($('import').hidden) openImport(file);
  else setImportFile(file);
});

// Two taps to remove a song you added: the first arms the button.
$('btn-remove-song').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const song = SONGS[selIndex];
  if (!song?.user) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to remove';
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'Remove'; } }, 3000);
    return;
  }
  await deleteUserSong(song.id);
  SONGS.splice(selIndex, 1);
  releaseSong(song);
  sendLibrary();
  renderSelect();
  select(Math.min(selIndex, SONGS.length - 1));
});

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('import').hidden) return closeImport();
  if (e.target.matches('input, select, textarea') || !$('import').hidden) return;
  const screen = document.body.dataset.screen;
  if (screen === 'title' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enterSelect(); }
  else if (screen === 'select') {
    if (e.key === 'ArrowLeft') select(selIndex - 1);
    else if (e.key === 'ArrowRight') select(selIndex + 1);
    else if (e.key === 'Enter' && e.target === document.body) startGame({ mode: 'mic' });
  } else if (screen === 'game' && (e.key === 'Escape' || e.key === 'p')) {
    $('pause').hidden ? pause() : resume();
  } else if (screen === 'results' && e.key === 'Enter' && e.target === document.body) startGame(lastOpts());
});

// ---------- Boot ----------
show('title');
setStage('img/stage-title.jpg');
setTheme(SONGS[selIndex]);
startVinyl($('platter'), $('rec'), () => document.body.dataset.screen === 'title');
// Test hook: ?singer=<audio url> makes room games sing that recording instead of the mic.
const roomSinger = params.get('singer') || undefined;
if (roomInLink()) {
  $('btn-start').hidden = true;
  $('btn-friends').querySelector('span').textContent = 'Join the room';
  $('friends-note').textContent = 'your friends are waiting';
}
window.__gv.songs = () => loadUserSongs().then(() => SONGS.map((s) => ({ id: s.id, title: s.title, user: !!s.user })));

// Automation and test hook: ?autoplay=<song id>&input=demo|mic|<audio url>&lyrics=1&difficulty=normal&players=Ann,Ben
// (players makes the recorded singer's part go round those names, two lines each).
if (params.get('autoplay')) {
  const input = params.get('input') || 'demo';
  const opts = {
    mode: input === 'demo' ? 'demo' : input === 'mic' ? 'mic' : 'file',
    url: input,
    name: params.get('name') || undefined,
    players: params.get('players')?.split(',') || undefined,
    audible: params.get('audible') === '1',
    lyrics: params.has('lyrics') ? params.get('lyrics') === '1' : undefined,
    difficulty: params.get('difficulty') || undefined,
    guide: params.get('guide') || undefined,
  };
  loadUserSongs().then(() => {
    const i = SONGS.findIndex((s) => s.id === params.get('autoplay'));
    if (i >= 0) selIndex = i;
    if (opts.lyrics) ensureChecker();
    window.__gv.start = () => startGame(opts);
    if (params.get('wait') !== '1') ensureEngine().then(() => startGame(opts));
  });
}
