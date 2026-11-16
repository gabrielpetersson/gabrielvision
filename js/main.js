// @ts-check
import { AudioEngine } from './audio-engine.js';
import { VoiceInput, openMic } from './voice-input.js';
import { Performance, DIFFICULTY } from './scoring.js';
import { StageRenderer, shownPitch } from './renderer.js';
import { LyricChecker, lyricMatch } from './lyric-check.js';
import { SONGS, loadChart, userSong, releaseSong, isOutdated } from './songs.js';
import { listUserSongs, getUserSong, saveUserSong } from './import/song-store.js';
import { packSong, unpackSong } from './share.js';
import { Room, inviteLink, roomInLink } from './room.js';
import { $, $$, clamp, pad, esc, fmt, fmtTime, reduced, segs, segbar, starRow, setLcd, Slide, makeEncoder } from './controls.js';

// The game is one instrument: a device face with screens for who's singing, the song, the settings, the song itself
// and the results. A device has one microphone. Several people on one device take turns on it; singing together
// means each singer on their own device, joined through the invite link. A friend's phone shows its own small screen
// (guest) until the host presses Sing.

const phone = matchMedia('(max-width: 1180px)');
const COLORS = ['#6EF3FF', '#FF77B7', '#B8FF6B', '#FFB547', '#A98BFF', '#FF8A5B'];
/** @param {number} i */
const color = (i) => COLORS[i % COLORS.length];
const MAX_SINGERS = 6; // the rack's channels; rooms/worker.js has the same limit
const MODES = /** @type {const} */ (['together', 'turns']);
const DIFFS = /** @type {const} */ (['easy', 'normal', 'hard']);
const GUIDES = /** @type {const} */ (['off', 'soft', 'full']);
const GUIDE_LEVEL = { off: 0, soft: 0.28, full: 0.9 };
const ROOM_LATE_MS = 15000; // a song that started longer ago than this is left to finish without this device
const params = new URLSearchParams(location.search);
const G = {
  plus: '<svg class="g" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  minus: '<svg class="g" viewBox="0 0 24 24"><path d="M5.5 12h13"/></svg>',
  link: '<svg class="g" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.2 1.2M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.2-1.2"/></svg>',
  on: '<svg class="g" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/></svg>',
  done: '<svg class="g" viewBox="0 0 24 24" aria-label="Done"><path d="M5.5 12.5 10 17l8.5-9.5"/></svg>',
};
const INVITE_LEGEND = `${G.link}<span>Copy link to invite online friends</span>`;
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err));

// ---------- Settings (per browser) ----------
/** What this browser remembered, checked field by field (an older version may have stored other shapes).
 * @returns {Settings} */
function loadSettings() {
  /** @type {any} */
  let s = {};
  try { s = JSON.parse(localStorage.getItem('gv:settings') || '{}') || {}; } catch {}
  /** @template {string} T @param {unknown} v @param {readonly T[]} list @returns {T} */
  const oneOf = (v, list) => (list.includes(/** @type {T} */ (v)) ? /** @type {T} */ (v) : list[0]);
  const players = (Array.isArray(s.players) ? s.players : [])
    .map((/** @type {any} */ p) => String(p?.name ?? '').trim().slice(0, 18)).filter(Boolean).slice(0, MAX_SINGERS).map((/** @type {string} */ name) => ({ name }));
  return {
    players: players.length ? players : [{ name: 'Player 1' }],
    mode: oneOf(s.mode, MODES),
    difficulty: DIFFS.includes(s.difficulty) ? s.difficulty : 'normal',
    guide: GUIDES.includes(s.guide) ? s.guide : 'soft',
    speakers: s.speakers === true,
    lyrics: s.lyrics !== false,
    latency: clamp(Math.round(+s.latency || 0), 0, 300),
    songId: typeof s.songId === 'string' ? s.songId : SONGS[0].id,
  };
}
const settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem('gv:settings', JSON.stringify(settings)); } catch {} };

// ---------- State ----------
/** @type {AudioEngine | null} */
let engine = null;
/** @type {StageRenderer | null} */
let renderer = null;
/** @type {LyricChecker | null} */
let checker = null;
/** @type {Game | null} the song being sung (or loading, or counting in) */
let game = null;
/** @type {Room | null} */
let room = null;
let screen = '';
window.__gv = { results: null, status: 'boot' };
const device = $('device');

function ensureEngine() {
  engine ||= new AudioEngine();
  const e = engine;
  return e.resume().then(() => e);
}

/** The speech model for the words check, one at a time: English-only for built-in songs (language null), the
 * multilingual one for uploads. @param {string | null} language */
function ensureChecker(language) {
  if (checker && (checker.language !== language || checker.dead)) {
    checker.dispose();
    checker = null;
  }
  checker ||= new LyricChecker(language, (s) => {
    if (screen === 'settings') syncWords();
    if (s.status === 'error') toast(`The words check isn't available: ${s.message}`);
  });
  return checker;
}
/** @param {Song | undefined} s */
const languageOf = (s) => (s?.kind === 'upload' ? s.chart.language ?? null : null);

/** @param {string} msg */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
toast.timer = undefined;

// ---------- The microphone: one per device ----------
/** @type {{ stream: MediaStream, speakers: boolean } | null} */
let mic = null;
/** @type {VoiceInput | null} drives the mic meters on the singers and guest screens */
let monitor = null;

// The Sound switch decides how the mic opens (echo cancellation for speakers), so a change reopens it.
async function micStream() {
  if (mic && mic.speakers === settings.speakers && mic.stream.active) return mic.stream;
  releaseMic();
  const stream = await openMic(settings.speakers);
  mic = { stream, speakers: settings.speakers };
  return stream;
}
// Nothing listens between screens: the browser's recording light goes off when the mic isn't needed.
function releaseMic() {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic = null;
}
async function startMonitor() {
  stopMonitor();
  const on = screen;
  try {
    const e = await ensureEngine();
    const m = new VoiceInput(e, { kind: 'mic', stream: await micStream() });
    await m.connect();
    if (screen === on && !monitor) monitor = m;
    else m.disconnect();
  } catch (err) {
    micError(err);
  }
}
function stopMonitor() {
  monitor?.disconnect();
  monitor = null;
  if (!game) releaseMic();
}
/** @param {unknown} err */
function micError(err) {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') toast('Microphone blocked. Allow it in the address bar, then reload.');
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') toast('No microphone found. Plug one in and try again.');
  else toast(`Microphone error: ${message(err)}`);
}

// ---------- Songs: built in, uploaded on this device, and friends' songs in the room ----------
/** @type {Promise<void> | null} */
let userSongsLoaded = null;
function loadUserSongs() {
  userSongsLoaded ||= listUserSongs().then((recs) => {
    let bad = 0;
    for (const r of recs) {
      try { SONGS.push(userSong(r)); } catch { bad++; }
    }
    if (bad) toast(`${bad} of your songs couldn't be opened.`);
  }, (err) => toast(`Your songs couldn't be read: ${message(err)}`));
  return userSongsLoaded;
}
/** @type {Map<string, { by: string, len: string }>} built-in songs' credit and length, once their charts load */
const credit = new Map();
/** @param {string} id */
const haveSong = (id) => SONGS.some((s) => s.id === id);
/** @param {string} id */
const builtIn = (id) => SONGS.some((s) => s.id === id && s.kind === 'builtin');

/** A friend's song that isn't on this device yet has no art here: rings in the song's own colours.
 * @param {string} title @param {string[]} accents */
function coverFor(title, accents) {
  let h = 7;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  let n = h || 7;
  const rnd = () => (n = (n * 16807) % 2147483647) / 2147483647;
  const fg = accents[1] || '#fffef9', acc = accents[0] || '#ffd23f';
  let s = '<rect width="640" height="640" fill="#141414"/>';
  for (let i = 4 + Math.floor(rnd() * 4); i > 0; i--) s += `<circle cx="${200 + rnd() * 240}" cy="${200 + rnd() * 240}" r="${i * 46}" fill="none" stroke="${i === 1 ? acc : fg}" stroke-width="${i === 1 ? 46 : 8}" opacity="${i === 1 ? 1 : 0.7}"/>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">${s}</svg>`);
}

/** Every song this device can pick: what's here, then songs friends in the room have that aren't here yet.
 * @returns {SongPick[]} */
function catalog() {
  /** @type {SongPick[]} */
  const list = SONGS.map((s) => s.kind === 'upload'
    ? { kind: 'here', id: s.id, song: s, title: s.title, by: s.artist, cover: s.cover, len: fmtTime(s.chart.duration) }
    : { kind: 'here', id: s.id, song: s, title: s.title, by: credit.get(s.id)?.by ?? '', cover: s.cover, len: credit.get(s.id)?.len ?? '' });
  const v = room?.view;
  if (v) {
    for (const m of v.members) {
      if (!m.here || v.mine.includes(m.id)) continue;
      for (const e of m.library) {
        if (list.some((x) => x.id === e.id)) continue;
        const t = transfers.get(e.id);
        list.push({ kind: 'friend', id: e.id, title: e.title, by: e.artist, cover: coverFor(e.title, e.accents), len: e.duration ? fmtTime(e.duration) : '', from: m.name, pct: t?.dir === 'get' ? Math.round(t.p * 100) : 0 });
      }
    }
  }
  return list;
}
const selectedId = () => room?.view?.room.song || (haveSong(settings.songId) ? settings.songId : SONGS[0].id);
const selectedSong = () => SONGS.find((s) => s.id === selectedId());
function selIndex(list = catalog()) {
  return Math.max(0, list.findIndex((x) => x.id === selectedId()));
}

/** @param {SongPick} s */
const tags = (s) => (s.kind === 'here' ? (s.song.kind === 'upload' ? '<i class="tag">Yours</i>' : '') : `<i class="tag">From ${esc(s.from)}</i>`);
/** @param {SongPick} s @param {number} i @param {number} total */
const lcdSong = (s, i, total) => `<div class="lcd__in">
  <img class="lcd__cover" src="${s.cover}" alt="">
  <div class="lcd__bar"><span><span><b>${pad(i + 1)}</b>/${pad(total)}</span></span><span>${tags(s)}${s.len ? `<span>${s.len}</span>` : ''}${s.kind === 'friend' ? `<span>${s.pct}%</span>` : ''}</span></div>
  <div class="lcd__meta"><p class="lcd__title">${esc(s.title)}</p><p class="lcd__by">${esc(s.by)}</p></div></div>`;
/** @param {SongPick} s @param {number} k @param {boolean} cur */
const trackRow = (s, k, cur) => `<li><button class="trk${s.kind === 'friend' ? ' is-wait' : ''}" type="button" data-pick="${esc(s.id)}"${cur ? ' aria-current="true"' : ''}>
  <i class="led${cur ? ' on' : ''}"></i><span class="trk__n">${k + 1}</span>
  <span class="trk__txt"><span class="trk__t">${esc(s.title)}</span><span class="trk__by">${esc(s.by)}${s.kind === 'friend' ? ` · from ${esc(s.from)}` : ''}</span></span>
  <span class="trk__r">${s.kind === 'here' ? tags(s) : `<i class="tag tag--o trk__from">From ${esc(s.from)}</i>`}${s.kind === 'friend' && s.pct > 0 ? `<span class="xfer"><span class="xfer__seg">${segs(s.pct)}</span>${s.pct}%</span>` : ''}${s.len ? `<span class="trk__len">${s.len}</span>` : ''}</span></button></li>`;
/** @param {SongPick[]} list */
const listKey = (list) => list.map((s) => `${s.id}:${s.kind === 'friend' ? s.pct : ''}:${s.by}:${s.len}`).join('|');

// ---------- Screens ----------
/** @type {Record<string, string>} */
const STEP_OF = { singers: 'singers', song: 'song', upload: 'song', 'upload-progress': 'song', outdated: 'song', settings: 'settings' };
/** @type {Record<string, () => void>} */
const enter = {
  title() { const g = /** @type {SVGGraphicsElement} */ (device.querySelector('.arm__g')); g.classList.remove('swing'); void g.getBBox(); g.classList.add('swing'); },
  singers() { renderSingers(); startMonitor(); },
  song() { renderSongList(); },
  settings() { renderSettings(); if (settings.lyrics) ensureChecker(languageOf(selectedSong())); },
  guest() { renderGuest(false); startMonitor(); },
  game() {},
  pause() { renderPause(); },
  upload() { renderUpload(); },
  'upload-progress'() {},
  outdated() {},
  results() {},
};
/** @param {string} name */
function go(name) {
  const prev = screen;
  screen = name;
  device.dataset.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('is-on', s.dataset.screen === name));
  $$('.step').forEach((b) => {
    const cur = b.dataset.step === STEP_OF[name];
    b.classList.toggle('is-cur', cur);
    if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.querySelector('.led')?.classList.toggle('on', cur);
  });
  if (name !== 'singers' && name !== 'guest') stopMonitor();
  // Leaving the progress screen any way at all cancels the upload.
  if (prev === 'upload-progress' && name !== 'upload-progress') importRun?.abort();
  enter[name]();
  if (prev && prev !== name) /** @type {HTMLElement | null} */ (device.querySelector('.screen.is-on'))?.focus({ preventScroll: true });
  window.__gv.screen = name;
}
/** @type {Record<string, string>} */
const BACK = { singers: 'title', song: 'singers', settings: 'song', upload: 'song', outdated: 'song' };
function back() {
  if (screen === 'guest') return leaveRoom();
  if (screen === 'game') return pause();
  if (screen === 'pause') return resume();
  if (screen === 'upload-progress') return go(upload.replace ? 'song' : 'upload');
  if (BACK[screen]) go(BACK[screen]);
}

// ---------- Singers: one channel rack for people on this device and friends online ----------
/** @typedef {{ key: string, name: string, c: number, local: number | null, member: Member | null, host: boolean }} Channel */
// In a room, this device's singers are the first room.seats.length players, seat i being player i.
const localPlayers = () => (room ? settings.players.slice(0, room.seats.length) : settings.players);
const roomMode = () => room?.view?.room.mode || settings.mode;
/** Without a room the channels are this device's singers. In a room they are the room's people in the order they
 * joined, which is also the order lines go round when taking turns. @returns {Channel[]} */
function channels() {
  const v = room?.view;
  if (!room || !v) return settings.players.map((p, i) => ({ key: `l${i}`, local: i, name: p.name, c: i, member: null, host: false }));
  const seats = room.seats.map((s) => s.id);
  return v.members.filter((m) => m.here).map((m) => {
    const i = seats.indexOf(m.id);
    const local = i >= 0 && i < settings.players.length ? i : null;
    return { key: m.id, member: m, local, name: local == null ? m.name : settings.players[local].name, c: m.color, host: m.id === v.room.host };
  });
}

/** @param {Channel[]} list */
const rackKey = (list) => list.map((s) => `${s.key}:${s.local == null ? s.name : ''}`).join('|');
let rack = { key: '', ids: /** @type {string[]} */ ([]) };
/** @param {Set<string>} [fresh] channels that just arrived (animated in) */
function renderSingers(fresh) {
  const list = channels(), rows = [];
  // In a room the first singer here holds the device's main seat and leaves only with the room.
  const canRemove = (/** @type {Channel} */ s) => s.local != null && localPlayers().length > 1 && !(room && s.local === 0);
  for (const [i, s] of list.entries()) {
    const online = s.local == null;
    const name = online
      ? `<span class="namebox"><span class="namebox__name">${esc(s.name)}</span><span class="namebox__on">${G.on}On their phone</span></span>`
      : `<label class="namebox"><input class="namebox__name" type="text" value="${esc(s.name)}" maxlength="18" spellcheck="false" autocomplete="off" data-singer="${s.local}" aria-label="Singer ${i + 1} name"></label>`;
    const anim = fresh?.has(s.key) ? (online ? ' is-join' : ' is-new') : '';
    rows.push(`<li class="ch${online ? ' is-online' : ''}${anim}" style="--c:${color(s.c)}">
    <span class="ch__no">${pad(i + 1)}</span><i class="ch__sw"></i>${name}
    <span class="meter meter--fill" data-meter="${esc(s.key)}" aria-hidden="true"></span>
    ${online ? '<span></span>' : `<button class="key key--round" type="button" data-remove="${s.local}" aria-label="Remove ${esc(s.name)}"${canRemove(s) ? '' : ' disabled'}><span class="top">${G.minus}</span></button>`}</li>`);
  }
  if (list.length < MAX_SINGERS) rows.push(`<li class="ch ch--add"><span class="ch__no">${pad(list.length + 1)}</span><span></span>
    <span class="addwrap"><button class="key key--round" type="button" data-add aria-label="Add singer"><span class="top">${G.plus}</span></button><span class="silk">Add singer</span></span></li>`);
  for (let i = list.length + 1; i < MAX_SINGERS; i++) rows.push(`<li class="ch ch--empty" aria-hidden="true"><span class="ch__no">${pad(i + 1)}</span></li>`);
  $('singer-rows').innerHTML = rows.join('');
  rack = { key: rackKey(list), ids: list.map((s) => s.key) };
  fitMeters();
  syncMode();
}
/** A filling meter gets as many LEDs as fit its column. */
function fitMeters() { for (const m of $$('.screen.is-on .meter--fill')) m.innerHTML = '<i class="led"></i>'.repeat(phone.matches ? 10 : clamp(Math.floor((m.clientWidth - 15) / 14), 8, 28)); }
addEventListener('resize', () => { if (screen === 'singers' || screen === 'guest') fitMeters(); });

// Together means everyone at once, so each singer needs their own mic: one singer per device. Two or more singers
// here take turns on this device's mic.
function syncMode() {
  const n = channels().length, local = localPlayers().length, sw = $('mode');
  const [together, turns] = mode.radios;
  const host = !room?.view || room.view.isHost;
  together.disabled = n < 2 || local > 1 || !host;
  turns.disabled = n < 2 || !host;
  if (host && local > 1 && roomMode() !== 'turns') setMode('turns');
  sw.classList.toggle('is-disabled', n < 2);
  sw.classList.toggle('is-max', local > 1);
  mode.set(roomMode());
}
/** @param {Mode} v */
function setMode(v) {
  settings.mode = v;
  saveSettings();
  if (room?.view?.isHost) room.act('set', { mode: v }).catch((err) => toast(message(err)));
}
async function addSinger() {
  if (channels().length >= MAX_SINGERS) return;
  let k = 1;
  while (settings.players.some((p) => p.name === `Player ${k}`)) k++;
  const p = { name: `Player ${k}` };
  // In a room the new singer gets the next seat; players after the seated ones (a guest's other saved singers) wait.
  const at = room ? room.seats.length : settings.players.length;
  settings.players.splice(at, 0, p);
  saveSettings();
  let key = `l${at}`;
  if (room) {
    try {
      key = await room.addSeat(p.name);
    } catch (err) {
      settings.players.splice(at, 1);
      saveSettings();
      toast(message(err));
    }
  }
  renderSingers(new Set([key]));
  $('singer-rows').querySelector('button')?.focus({ preventScroll: true });
}
/** @param {number} i */
function removeSinger(i) {
  if (localPlayers().length < 2 || i >= localPlayers().length || (room && i === 0)) return;
  if (room) room.removeSeat(room.seats[i].id);
  settings.players.splice(i, 1);
  saveSettings();
  renderSingers();
}

// The first copy makes the room: this device's singers each take a seat, and friends who open the link take the
// next free channels.
/** @param {HTMLElement} btn */
async function copyInvite(btn) {
  const top = /** @type {HTMLElement} */ (btn.querySelector('.top'));
  try {
    if (!room) {
      await openRoom();
      renderSingers();
    }
    const link = inviteLink(/** @type {Room} */ (room).main.code);
    const ok = await navigator.clipboard.writeText(link).then(() => true, () => false);
    top.innerHTML = ok ? '<i class="led led--mint on"></i><span>Copied</span>' : `<i class="led on"></i><span>${esc(link)}</span>`;
  } catch (err) {
    top.innerHTML = '<i class="led on"></i><span>Couldn’t make a room</span>';
    toast(message(err));
  }
  clearTimeout(copyInvite.timer);
  copyInvite.timer = setTimeout(() => { top.innerHTML = INVITE_LEGEND; }, 2400);
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
copyInvite.timer = undefined;

// ---------- Live mic LEDs ----------
// This device's channels show its microphone; a friend's channel shows the level their phone sends with each poll.
/** @type {Map<string, { peak: number, hold: number }>} */
const peaks = new Map();
let lastMeter = 0, lastLevelSent = 0;
/** @param {number} t */
function meters(t) {
  requestAnimationFrame(meters);
  if (t - lastMeter < (reduced.matches ? 180 : 60)) return;
  lastMeter = t;
  monitor?.drain();
  const level = monitor?.level ?? 0;
  const list = screen === 'singers' || screen === 'guest' ? channels() : [];
  for (const m of $$('.screen.is-on .meter[data-meter]')) {
    const key = /** @type {string} */ (m.dataset.meter);
    const s = list.find((x) => x.key === key);
    if (!s) continue;
    const lvl = s.local != null ? level : clamp(+(s.member?.live.level ?? 0) || 0, 0, 1);
    const L = m.children, n = L.length;
    let v = peaks.get(key);
    if (!v) peaks.set(key, (v = { peak: 0, hold: 0 }));
    const lit = Math.round(clamp(lvl * 1.25, 0, 1) * n);
    if (lit >= v.peak) { v.peak = lit; v.hold = t + 650; } else if (t > v.hold) { v.peak = Math.max(lit, v.peak - 1); v.hold = t + 80; }
    for (let i = 0; i < n; i++) L[i].classList.toggle('on', i < lit || (v.peak > 1 && i === v.peak - 1));
  }
  // Friends see this device's level too, at the pace of the room's polls.
  if (room && list.length && t - lastLevelSent > 300) {
    lastLevelSent = t;
    for (const s of list) if (s.local != null && s.member) room.setLive({ level: Math.round(level * 20) / 20 }, s.member.id);
  }
}
requestAnimationFrame(meters);

// ---------- Song ----------
let songListKey = '';
function renderSongList() {
  const list = catalog(), sel = selIndex(list);
  $('tracks-song').innerHTML = list.map((s, k) => trackRow(s, k, k === sel)).join('');
  encSong.refresh();
  markTracks(sel);
  setLcd($('lcd-song'), lcdSong(list[sel], sel, list.length));
  $('enc-song').setAttribute('aria-valuetext', list[sel].title);
  songListKey = listKey(list);
}
/** @param {number} sel */
function markTracks(sel) {
  $$('.trk', $('tracks-song')).forEach((b, k) => {
    const cur = k === sel;
    if (cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    b.querySelector('.led')?.classList.toggle('on', cur);
  });
  $$('.enc__ticks text', $('enc-song')).forEach((t) => t.classList.toggle('cur', Number(t.dataset.i) === sel));
  // The picked song's row stays in view in a long list (only the list scrolls, never the page).
  const list = $('tracks-song'), row = /** @type {HTMLElement | undefined} */ (list.children[sel]);
  if (row && list.scrollHeight > list.clientHeight) {
    const top = row.offsetTop - list.offsetTop, bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
}
/** @param {number} i @param {number} dir */
function selectSong(i, dir) {
  const list = catalog(), s = list[i];
  if (!s || (room?.view && !room.view.isHost)) return;
  settings.songId = s.id;
  saveSettings();
  if (room?.view?.isHost) room.act('set', { song: s.id }).catch((err) => toast(message(err)));
  markTracks(i);
  setLcd($('lcd-song'), lcdSong(s, i, list.length), dir);
  $('enc-song').setAttribute('aria-valuetext', s.title);
}
// An upload made by an older version asks, each time it's picked, whether to remake it first.
let outdatedOk = false;
function toSettings() {
  const s = selectedSong();
  if (s && isOutdated(s) && !outdatedOk) return askRemake(s);
  outdatedOk = false;
  go('settings');
}

// ---------- Settings ----------
function renderSettings() {
  const list = catalog(), i = selIndex(list);
  setLcd($('lcd-set'), lcdSong(list[i], i, list.length));
  diff.set(String(DIFFS.indexOf(settings.difficulty)));
  out.set(settings.speakers ? '1' : '0');
  vocal.set(String(GUIDES.indexOf(settings.guide)));
  syncWords();
  syncSing();
}
let starting = false; // a room start on its way to the server
// Sing waits for a friend's song to arrive on every device in the room.
function syncSing() {
  const v = room?.view, list = catalog(), s = list[selIndex(list)];
  let note = '';
  if (s.kind === 'friend') note = `${s.title} arriving · ${s.pct}%`;
  else if (v && remoteHere()) {
    const { missing } = songHolders(v, s.id);
    if (missing.length) note = `Sending ${s.title} · ${missing.map((m) => m.name).join(', ')}`;
  }
  /** @type {HTMLButtonElement} */ ($('sing')).disabled = !!note || starting || (!!v && !v.isHost);
  $('sing-note').textContent = note;
}
function syncWords() {
  const on = settings.lyrics, st = checker?.state;
  $('latch-words').setAttribute('aria-checked', String(on));
  $('words-led').classList.toggle('on', on);
  $('words-state').textContent = !on ? 'Off' : st?.status === 'loading' ? `Loading ${Math.round((st.progress || 0) * 100)}%` : 'On';
}

// ---------- Rooms: friends online ----------
// A room exists once someone copies the invite link (or opens one). Each person sings on their own device; the host
// picks the song and starts it on every device at the same moment, and scores travel through the room service.
// Songs people uploaded are listed for the whole room; a picked one goes from someone who has it to everyone who
// doesn't, and stays in their library afterwards.
let roomPlayed = 0; // the last round this device played or sat out
/** @type {Map<string, { dir: 'send' } | { dir: 'get', p: number }>} transfers this device is running */
const transfers = new Map();
// Newest first: the room service keeps the first 60.
const myLibrary = () => SONGS.flatMap((s) => (s.kind === 'upload' ? [{ id: s.id, title: s.title, artist: s.artist, duration: s.chart.duration, language: s.chart.language || '', accents: s.accents }] : [])).reverse();
const sendLibrary = () => { if (room) for (const seat of room.seats) room.send({ library: myLibrary() }, seat.id); };
const remoteHere = () => !!room?.view?.members.some((m) => m.here && !room?.view?.mine.includes(m.id));

/** Who in the room has the picked song, and who still needs it. This device's seats all have what it has.
 * @param {RoomView} view @param {string} id */
function songHolders(view, id) {
  const here = view.members.filter((m) => m.here);
  const has = (/** @type {Member} */ m) => (view.mine.includes(m.id) ? haveSong(id) : builtIn(id) || m.library.some((e) => e.id === id));
  return { holders: here.filter(has), missing: here.filter((m) => !has(m)) };
}

/** The first person here who has the picked song sends it once; everyone without it fetches it once it's sent.
 * @param {RoomView} view */
function runTransfers(view) {
  const id = view.room.song;
  if (!room || !id || builtIn(id) || transfers.has(id)) return;
  const { holders, missing } = songHolders(view, id);
  if (!missing.length) return;
  if (haveSong(id)) {
    if (holders.length && view.mine.includes(holders[0].id) && !room.main.live.sent?.[id]) sendSong(room, id);
  } else {
    const sender = view.members.find((m) => m.here && m.live.sent?.[id]);
    if (sender) getSong(room, id, sender);
  }
}
/** A failed transfer is tried again a little later. @param {string} id */
const retryLater = (id) => setTimeout(() => transfers.delete(id), 10000);
/** @param {Room} r @param {string} id */
async function sendSong(r, id) {
  transfers.set(id, { dir: 'send' });
  try {
    const rec = await getUserSong(id);
    if (!rec) throw new Error('It is no longer on this device.');
    const blob = await packSong(rec, () => {});
    await r.upload(id, blob, () => {});
    r.setLive({ sent: { ...r.main.live.sent, [id]: blob.size } });
    transfers.delete(id);
  } catch (err) {
    toast(`Sending the song failed: ${message(err)}`);
    retryLater(id);
  }
}
/** @param {Room} r @param {string} id @param {Member} sender */
async function getSong(r, id, sender) {
  const t = { dir: /** @type {const} */ ('get'), p: 0 };
  transfers.set(id, t);
  try {
    const blob = await r.download(id, sender.live.sent?.[id] ?? 1, (p) => { t.p = p; refreshRoomScreens(); });
    const rec = await unpackSong(blob, sender.name, id);
    await saveUserSong(rec);
    if (!haveSong(id)) SONGS.push(userSong(rec));
    sendLibrary();
    transfers.delete(id);
  } catch (err) {
    if (r !== room) return;
    toast(`${sender.name}’s song didn’t arrive: ${message(err)}`);
    retryLater(id);
  }
  refreshRoomScreens();
}

/** Makes a room from this device's singers: the first singer's seat is the host, the others join after. */
async function openRoom() {
  await loadUserSongs();
  const r = new Room(onRoomUpdate, leaveRoom);
  room = r;
  roomPlayed = 0;
  transfers.clear();
  try {
    const [first, ...rest] = settings.players;
    const code = await r.enter(null, first.name);
    for (const p of rest) await r.addSeat(p.name);
    sendLibrary();
    await r.act('set', { song: selectedId(), mode: settings.mode, difficulty: settings.difficulty });
    history.replaceState(null, '', `#room=${code}`);
    window.__gv.room = code;
  } catch (err) {
    r.leave();
    room = null;
    throw err;
  }
}

/** A friend's phone, after opening the link: one seat, then its own screen until the host starts. @param {string} code */
async function joinRoom(code) {
  await ensureEngine();
  await loadUserSongs();
  const r = new Room(onRoomUpdate, leaveRoom);
  room = r;
  roomPlayed = 0;
  transfers.clear();
  try {
    // Seats kept from earlier in this tab come back with the singers they belonged to (a host who reloaded).
    const joined = await r.enter(code, settings.players[0].name);
    sendLibrary();
    history.replaceState(null, '', `#room=${joined}`);
    window.__gv.room = joined;
    const v = /** @type {RoomView} */ (r.view);
    // Don't drop into a song that has been playing for a while; wait for the next one.
    if (v.room.startAt && r.serverNow() - v.room.startAt > ROOM_LATE_MS) roomPlayed = v.room.round;
    go(v.isHost ? 'singers' : 'guest');
  } catch (err) {
    leaveRoom(message(err));
  }
}
const isGuest = () => !!room?.view && !room.view.isHost;

/** @param {string} [why] shown when the room closed under this device */
function leaveRoom(why) {
  if (game?.start.kind === 'room') stopGame();
  room?.leave();
  room = null;
  transfers.clear();
  history.replaceState(null, '', location.pathname + location.search);
  window.__gv.room = null;
  if (why) toast(why);
  go('title');
}

/** @param {RoomView} view */
function onRoomUpdate(view) {
  const r = view.room;
  if (!room) return;
  // The host started a new song: play it (also from the results of the last one).
  if (r.round > roomPlayed && r.startAt && room.serverNow() - r.startAt < ROOM_LATE_MS && !game) {
    roomPlayed = r.round;
    const roster = r.roster.flatMap((id) => view.members.filter((m) => m.id === id));
    // A device that doesn't have the song yet sits this one out (and tells the others) and gets it for the next.
    if (!haveSong(r.song)) {
      for (const seat of room.seats) if (r.roster.includes(seat.id)) room.send({ result: { round: r.round, left: true } }, seat.id);
      refreshRoomScreens();
      return;
    }
    startGame({ kind: 'room', song: r.song, turns: r.mode === 'turns', difficulty: r.difficulty, roster, mine: view.mine, round: r.round, startAt: r.startAt });
    return;
  }
  // The host's role moved (the host went quiet for a while): the screens follow it.
  if (screen === 'guest' && view.isHost) go('singers');
  else if (!view.isHost && ['singers', 'song', 'settings', 'outdated'].includes(screen)) go('guest');
  if (screen === 'results' && lastResults?.g.start.kind === 'room') printResults(lastResults.g, lastResults.mine, false);
  if (!game) runTransfers(view);
  refreshRoomScreens();
}

// Room changes redraw only what changed on the screen showing, so names being typed and animations aren't reset.
function refreshRoomScreens() {
  if (screen === 'singers') {
    const list = channels();
    if (rackKey(list) !== rack.key) {
      const was = new Set(rack.ids);
      renderSingers(new Set(list.map((s) => s.key).filter((k) => !was.has(k))));
    } else syncMode();
  } else if (screen === 'song') {
    if (listKey(catalog()) !== songListKey) renderSongList();
  } else if (screen === 'settings') syncSing();
  else if (screen === 'guest') renderGuest(true);
}

// ---------- Guest: a friend's phone shows the room and waits for the host ----------
let guestKeys = { rack: '', lcd: '' };
/** @param {boolean} update */
function renderGuest(update) {
  const v = room?.view;
  if (!v) return;
  const hostName = v.members.find((m) => m.id === v.room.host)?.name || 'The host';
  $('h-guest').textContent = `${hostName}’s room`;
  const list = channels();
  const rackNow = list.map((s) => `${s.key}:${s.name}:${s.host}`).join('|');
  if ((!update || rackNow !== guestKeys.rack) && !$('guest-row').contains(document.activeElement)) {
    guestKeys.rack = rackNow;
    const rows = list.map((s, i) => {
      const name = s.local != null
        ? `<label class="namebox"><input class="namebox__name" type="text" value="${esc(s.name)}" maxlength="18" spellcheck="false" autocomplete="off" data-singer="${s.local}" aria-label="Your name"><span class="namebox__on">You</span></label>`
        : `<span class="namebox"><span class="namebox__name">${esc(s.name)}</span>${s.host ? '<span class="namebox__on">Host</span>' : ''}</span>`;
      return `<li class="ch" style="--c:${color(s.c)}"><span class="ch__no">${pad(i + 1)}</span><i class="ch__sw"></i>${name}
        <span class="meter meter--fill" data-meter="${esc(s.key)}" aria-hidden="true"></span></li>`;
    });
    for (let i = list.length + 1; i <= MAX_SINGERS; i++) rows.push(`<li class="ch ch--empty" aria-hidden="true"><span class="ch__no">${pad(i)}</span></li>`);
    $('guest-row').innerHTML = rows.join('');
    fitMeters();
  }
  const picked = v.room.song ? catalog().find((s) => s.id === v.room.song) : undefined;
  const lcdNow = picked ? `${picked.id}:${picked.kind === 'friend' ? picked.pct : ''}:${hostName}` : `none:${hostName}`;
  if (!update || lcdNow !== guestKeys.lcd) {
    guestKeys.lcd = lcdNow;
    setLcd($('lcd-guest'), picked
      ? `<div class="lcd__in"><img class="lcd__cover" src="${picked.cover}" alt="">
        <div class="lcd__bar"><span><b>${esc(hostName)} picked</b></span><span>${picked.len}</span></div>
        <div class="lcd__meta"><p class="lcd__title">${esc(picked.title)}</p><p class="lcd__by">${esc(picked.by)}</p></div></div>`
      : `<div class="lcd__in lcd__in--msg"><div class="lcd__bar"><span>Song</span></div><p class="lcd__title">${esc(hostName)} is picking a song</p></div>`, update ? 1 : 0);
  }
  $$('.g-ind').forEach((el) => { const on = !!picked && el.dataset.mode === v.room.mode; el.classList.toggle('is-on', on); el.querySelector('.led')?.classList.toggle('on', on); });
  // A song on its way to this phone.
  const t = picked && transfers.get(picked.id);
  $('guest-send').hidden = t?.dir !== 'get';
  if (picked && t?.dir === 'get') {
    const pct = Math.round(t.p * 100);
    $('guest-send-l').textContent = `Getting ${picked.title}`;
    $('guest-xfer').innerHTML = `<span class="xfer__seg">${segs(pct)}</span>${pct}%`;
  }
  $('guest-wait').textContent = picked ? `Waiting for ${hostName} to press Sing` : `Waiting for ${hostName} to pick a song`;
}

// ---------- Game ----------
/** A singer in a game: someone on this device (scored here) or a friend singing on their own device.
 * @typedef {{ kind: 'here', name: string, color: string, member: string | null, perf: Performance, shown: number }} HereSinger
 * @typedef {{ kind: 'online', name: string, color: string, member: string, shown: number }} OnlineSinger
 * @typedef {HereSinger | OnlineSinger} Singer */
/** @typedef {{
 *   start: Start, state: 'starting' | 'playing' | 'ended', song: Song, chart: Chart, inst: AudioBuffer, vocals: AudioBuffer, guide: number,
 *   singers: Singer[], here: HereSinger[], input: VoiceInput | null, voice: { id: string, color: string, frames: Frame[] },
 *   turns: boolean, owners: (number | null)[], difficulty: Difficulty, lyricsOn: boolean, round: number | null,
 *   shownAt: { disp: number | null, t: number }, pendingChecks: number, ui: string, counted: Set<number>, sentAt: number
 * }} Game */

/** Starts a song: on this device (local), on every device in the room at once (room), or with a recording singing
 * (test). Any game already running ends first. @param {Start} start */
async function startGame(start) {
  stopGame();
  stopMonitor();
  const song = start.kind === 'local' ? selectedSong() : SONGS.find((s) => s.id === start.song);
  if (!song) return toast('That song isn’t on this device.');
  go('game');
  $('pt-title').textContent = song.title;
  $('pt-time').textContent = '';
  $('ly-now').innerHTML = '';
  $('ly-next').textContent = '';
  delete $('hw-call').dataset.k;
  call('Loading', null);
  $('chans').innerHTML = '';
  /** @type {VoiceInput | null} */
  let input = null;
  // Every await below can come back to a different game (quit, restart, leaving the room): this one then stops.
  const token = {};
  startGame.token = token;
  const stale = () => startGame.token !== token;
  try {
    const e = await ensureEngine();
    const [chart, inst, vocals] = await Promise.all([loadChart(song), e.load(song.inst), e.load(song.vocals)]);
    if (stale()) return;
    const difficulty = start.kind === 'local' ? settings.difficulty : start.difficulty;
    // Who sings: this device's singers, the room's people (this device's seats sing here), or the test's names.
    let cast = start.kind === 'room'
      ? start.roster.map((m) => ({ name: m.name, c: m.color, member: /** @type {string | null} */ (m.id), here: start.mine.includes(m.id) }))
      : (start.kind === 'local' ? localPlayers().map((p) => p.name) : start.names).map((name, i) => ({ name, c: i, member: null, here: true }));
    // Several people on one device always take turns: they share its mic.
    const turns = cast.length > 1 && (start.kind === 'room' ? start.turns : true);
    // Lines go out two at a time round everyone (one at a time when the song is short), so everyone gets some.
    const perTurn = chart.lines.length >= 2 * cast.length ? 2 : 1;
    if (turns) cast = cast.slice(0, chart.lines.length);
    const owners = chart.lines.map((_, i) => (turns ? Math.floor(i / perTurn) % cast.length : null));
    /** @type {Singer[]} */
    const singers = cast.map((c, i) => {
      const base = { name: c.name, color: color(c.c), shown: 0 };
      if (!c.here) return { ...base, kind: 'online', member: /** @type {string} */ (c.member) };
      const owned = turns ? new Set(owners.flatMap((o, li) => (o === i ? [li] : []))) : null;
      return { ...base, kind: 'here', member: c.member, perf: new Performance(chart, difficulty, owned) };
    });
    const here = singers.filter((p) => p.kind === 'here');
    const lyricsOn = here.length > 0 && (start.kind === 'test' ? start.lyrics : settings.lyrics);
    if (lyricsOn) ensureChecker(chart.language ?? null);
    // The voice: the mic, or for the demo and tests a recording (?singer= makes room games use one too).
    if (here.length) {
      const recording = start.kind === 'test' ? (start.voice === 'demo' ? song.vocals : start.voice) : start.kind === 'room' ? roomSinger : null;
      const source = /** @type {VoiceSource} */ (recording
        ? { kind: 'recording', buffer: await e.load(recording), audible: start.kind === 'test' && start.audible }
        : { kind: 'mic', stream: await micStream() });
      if (stale()) return;
      input = new VoiceInput(e, source);
      input.latency = settings.latency / 1000;
      await input.connect();
      input.enablePcm(lyricsOn);
    }
    if (stale()) return input?.disconnect();
    if (!renderer) renderer = new StageRenderer(/** @type {HTMLCanvasElement} */ ($('hw')));
    renderer.resize();
    renderer.setSong(chart);
    renderChans(singers, turns);
    const guide = start.kind === 'test' ? (start.voice === 'demo' ? 0 : GUIDE_LEVEL[start.guide]) : GUIDE_LEVEL[settings.guide];
    /** @type {Game} */
    const g = {
      start, state: 'starting', song, chart, inst, vocals, guide, singers, here, input, voice: { id: 'mic', color: here[0]?.color ?? '#fff', frames: input?.history ?? [] },
      turns, owners, difficulty, lyricsOn, round: start.kind === 'room' ? start.round : null, shownAt: { disp: null, t: 0 },
      pendingChecks: 0, ui: '', counted: new Set(), sentAt: 0,
    };
    game = g;
    // A room's song starts at the same moment on every device; a device that is late joins mid-song.
    let offset = 0;
    if (start.kind === 'room') {
      for (;;) {
        const wait = start.startAt - /** @type {Room} */ (room).serverNow();
        // engine.play starts 0.15 s from now: begin that far into the song past where the room is.
        if (wait <= 160) { offset = Math.max(0, 0.15 - wait / 1000); break; }
        call(String(Math.ceil(wait / 1000)), null, true);
        await sleep(Math.min(250, wait - 150));
        if (game !== g) return;
      }
    }
    call('', null);
    playFrom(g, offset);
    g.state = 'playing';
    window.__gv.status = 'playing';
    requestAnimationFrame(tick);
  } catch (err) {
    console.error(err);
    input?.disconnect();
    if (stale()) return;
    game = null;
    releaseMic();
    call('', null);
    if (err instanceof DOMException && /Allowed|NotFound|Overconstrained/.test(err.name)) micError(err);
    else toast(message(err));
    go(isGuest() ? 'guest' : 'settings');
    window.__gv.status = 'error';
    window.__gv.error = message(err);
  }
}
/** @type {object | null} */
startGame.token = null;

/** Plays the song from `offset` seconds in, with the voice on the same clock. @param {Game} g @param {number} offset */
function playFrom(g, offset) {
  const at = /** @type {AudioEngine} */ (engine).play({ inst: g.inst, vocals: g.vocals, guide: g.guide, offset });
  g.input?.start(at);
}

/** The layer over the highway: the countdown, loading, and whose turn it is.
 * @param {string} text @param {string | null} c @param {boolean} [count] */
function call(text, c, count = false) {
  const el = $('hw-call');
  el.textContent = text;
  el.style.setProperty('--cc', c || 'var(--face)');
  el.classList.toggle('is-count', count);
  el.classList.toggle('is-on', !!text);
}

/** @param {Singer[]} singers @param {boolean} turns */
function renderChans(singers, turns) {
  const el = $('chans');
  el.style.setProperty('--n', String(singers.length));
  el.classList.toggle('is-turns', turns);
  el.innerHTML = singers.map((p) => `<li class="chan" style="--c:${p.color}">
    <div class="chan__id"><i class="led" aria-hidden="true"></i><i class="ch__sw"></i><span class="chan__name">${esc(p.name)}</span>${p.kind === 'online' ? `<span class="chan__on" title="On their phone">${G.on}<span class="sr">on their phone</span></span>` : ''}</div>
    <div class="chan__score"><span class="chan__num">0</span></div>
    <div class="chan__foot"><span class="chan__x" aria-label="Combo">${[1, 2, 3, 4].map((x) => `<span><i class="led"></i>×${x}</span>`).join('')}</span>
      <span class="chan__streak"><span class="silk">Streak</span><b>0</b></span></div></li>`).join('');
}

/** The nearest note this singer sings, for drawing a voice that is between notes. @param {Performance} perf @param {number} t */
function nearestNote(perf, t) {
  let best = null, dist = 1.2;
  for (let i = Math.max(0, perf.cursor - 2); i < Math.min(perf.notes.length, perf.cursor + 3); i++) {
    const n = perf.notes[i];
    // Someone else's line in take-turns scores nothing, so the line must not look like it's on it.
    if (n.skip) continue;
    const d = t < n.t ? n.t - t : t > n.t + n.d ? t - n.t - n.d : 0;
    if (d < dist) { dist = d; best = n; }
  }
  return best;
}

/** The line being sung at t, or the next one coming up. @param {Game} g @param {number} t */
function lineAt(g, t) {
  const i = g.chart.lines.findIndex((l) => t < l.end + 0.3);
  return i < 0 ? g.chart.lines.length - 1 : i;
}
/** Whose turn it is at line i (take turns only). @param {Game} g @param {number} i */
const ownerOf = (g, i) => { const o = g.owners[i]; return o == null ? null : g.singers[o]; };
/** A friend's live numbers for this round, from their latest poll. @param {Game} g @param {OnlineSinger} p */
function liveOf(g, p) {
  const live = room?.view?.members.find((m) => m.id === p.member)?.live;
  return live?.round === g.round ? live : null;
}

function tick() {
  const g = game;
  if (!g || g.state !== 'playing' || !engine) return;
  if (engine.playing?.pausedAt != null) { requestAnimationFrame(tick); return; }
  const now = engine.heardTime();
  const r = /** @type {StageRenderer} */ (renderer);
  const center = (r.lo + r.hi) / 2;
  const tuning = g.chart.tuning ?? 0;
  for (const f of g.input?.drain() ?? []) {
    for (const p of g.here) p.perf.feed(f.t, f.midi);
    // Taking turns, the line follows whoever's turn it is; it's drawn against their notes.
    const owner = g.turns ? ownerOf(g, lineAt(g, f.t)) : null;
    const perf = (owner?.kind === 'here' ? owner : g.here[0]).perf;
    const n = f.midi == null ? null : perf.current || nearestNote(perf, f.t);
    f.disp = shownPitch(f.midi == null ? null : f.midi - tuning, n, center, g.shownAt, f.t);
  }
  for (const p of g.here) for (const line of p.perf.finished.splice(0)) if (g.lyricsOn) checkWords(g, p, line, 500);
  if (g.turns) {
    const owner = ownerOf(g, lineAt(g, now));
    if (owner?.kind === 'here') g.voice.color = owner.color;
  }
  r.draw(now, g.here, g.input ? [g.voice] : []);
  if (room && g.round != null && performance.now() - g.sentAt > 900) {
    g.sentAt = performance.now();
    for (const p of g.here) if (p.member) room.setLive({ round: g.round, score: p.perf.score, mult: p.perf.multiplier, combo: p.perf.combo }, p.member);
  }
  updateLyrics(g, now);
  updateChans(g, now);
  countdown(g, now);
  if (now >= g.chart.duration + 0.3) endGame(g);
  else requestAnimationFrame(tick);
}

/** Listens to a finished line `delay` ms later (its last notes need to arrive) and cuts its points if the words weren't
 * sung. @param {Game} g @param {HereSinger} p @param {import('./scoring.js').ScoredLine} line @param {number} delay */
function checkWords(g, p, line, delay) {
  if (line.points + line.bonus === 0) return;
  g.pendingChecks++;
  setTimeout(() => {
    const done = () => { g.pendingChecks--; };
    const audio = game === g ? g.input?.audioBetween(line.start - 0.25, line.end + 0.35) : null;
    if (!audio || !checker || checker.dead) return done();
    checker.transcribe(audio)
      .then((/** @type {string} */ text) => {
        if (game !== g) return;
        const ratio = lyricMatch(line.text, text);
        p.perf.applyLyric(line.index, ratio);
        (window.__gv.lyricLog ||= []).push({ player: p.name, line: line.text, heard: text, ratio });
      })
      .catch((/** @type {unknown} */ err) => console.warn('words check failed', err))
      .finally(done);
  }, delay);
}

/** The current line, its sung syllables lit; the next line under it. In a gap, the next line waits unlit.
 * @param {Game} g @param {number} now */
function updateLyrics(g, now) {
  const lines = g.chart.lines;
  const i = lines.findIndex((l) => now < l.end + 0.3);
  const line = i >= 0 ? lines[i] : null;
  const waiting = !!line && line.start - now > 2;
  const k = line && !waiting ? line.notes.findLastIndex((n) => n.t <= now) : -1;
  const key = `${i}:${k}:${waiting}`;
  if (key === g.ui) return;
  g.ui = key;
  $('hw-lyr').style.setProperty('--lc', (g.turns && i >= 0 ? ownerOf(g, i)?.color : null) || '#3ff0b4');
  $('ly-now').innerHTML = line ? line.notes.map((n, j) => (n.syl === '~' ? '' : `<span class="${j < k ? 'd' : j === k ? 'n' : ''}">${esc(n.syl)}</span>`) + (n.wordEnd ? ' ' : '')).join('') : '';
  $('ly-next').textContent = i >= 0 && lines[i + 1] ? lines[i + 1].text : '';
}

/** @param {Game} g @param {number} now */
function updateChans(g, now) {
  const { chart, singers } = g;
  // Taking turns: only the singer up now is lit, and their name is called before their first line.
  const live = g.turns ? g.owners[lineAt(g, now)] : null;
  if (g.turns) {
    const lines = chart.lines, next = lines.findIndex((l) => l.start > now);
    const owner = next >= 0 ? ownerOf(g, next) : null;
    const due = !!owner && lines[next].start - now < 2.6 && (next === 0 || g.owners[next - 1] !== g.owners[next]);
    const el = $('hw-call');
    if (owner && due && el.dataset.k !== String(next)) {
      el.dataset.k = String(next);
      call(`${owner.name}’s turn`, owner.color);
    } else if (!due && el.dataset.k != null && !el.classList.contains('is-count')) {
      delete el.dataset.k;
      call('', null);
    }
  }
  $$('#chans .chan').forEach((el, si) => {
    const p = singers[si];
    const on = live == null || si === live;
    el.classList.toggle('is-live', on);
    el.querySelector('.chan__id .led')?.classList.toggle('on', on);
    const lv = p.kind === 'online' ? liveOf(g, p) : null;
    const { score, mult, combo } = p.kind === 'here'
      ? { score: p.perf.score, mult: p.perf.multiplier, combo: p.perf.combo }
      : { score: +(lv?.score ?? 0) || 0, mult: clamp(+(lv?.mult ?? 1) || 1, 1, 4), combo: Math.max(0, Math.round(+(lv?.combo ?? 0) || 0)) };
    p.shown += (score - p.shown) * 0.2;
    if (Math.abs(score - p.shown) < 1) p.shown = score;
    const v = fmt(Math.round(p.shown / 10) * 10), num = /** @type {HTMLElement} */ (el.querySelector('.chan__num'));
    if (num.textContent !== v) num.textContent = v;
    el.querySelectorAll('.chan__x > span').forEach((x, i) => { x.classList.toggle('is-on', i < mult); x.querySelector('.led')?.classList.toggle('on', i < mult); });
    const st = /** @type {HTMLElement} */ (el.querySelector('.chan__streak b'));
    if (st.textContent !== String(combo)) st.textContent = String(combo);
  });
  $('hw-prog').style.transform = `scaleX(${clamp(now / chart.duration, 0, 1)})`;
  const time = `${fmtTime(now)} / ${fmtTime(chart.duration)}`;
  if ($('pt-time').textContent !== time) $('pt-time').textContent = time;
}

/** 3, 2, 1 on the beats before the first note (taking turns calls the first singer instead). @param {Game} g @param {number} now */
function countdown(g, now) {
  const first = g.chart.lines[0]?.notes[0];
  if (!first || g.turns || !(g.chart.bpm > 0)) return;
  const spb = 60 / g.chart.bpm;
  const left = Math.ceil((first.t - now) / spb);
  if (left >= 1 && left <= 3 && !g.counted.has(left)) {
    g.counted.add(left);
    call(String(left), null, true);
    setTimeout(() => { if (game === g && $('hw-call').textContent === String(left)) call('', null); }, spb * 950);
  }
}

/** @param {Game} g */
async function endGame(g) {
  if (g.state === 'ended') return;
  g.state = 'ended';
  /** @type {AudioEngine} */ (engine).stop();
  // Lines that end with the song finish now; their words are checked too.
  for (const p of g.here) {
    p.perf.completeBefore(Infinity);
    for (const line of p.perf.finished.splice(0)) if (g.lyricsOn) checkWords(g, p, line, 0);
  }
  if (g.pendingChecks > 0) {
    call('Checking the words', null);
    const t0 = performance.now();
    while (g.pendingChecks > 0 && performance.now() - t0 < 15000 && game === g) await sleep(150);
  }
  if (game !== g) return;
  game = null;
  call('', null);
  g.input?.disconnect();
  releaseMic();
  const mine = g.here.map((p) => ({ p, r: p.perf.finish() }));
  window.__gv.results = mine.map(({ p, r }) => ({ name: p.name, ...r }));
  window.__gv.status = 'done';
  if (room && g.round != null) for (const { p, r } of mine) if (p.member) room.send({ result: { round: g.round, score: r.score, accuracy: r.accuracy, title: r.title, stars: r.stars, left: false } }, p.member);
  go('results');
  printResults(g, mine, true);
}

/** Ends the game now (quit, restart, leaving the room). Friends in the room see this device's singers as left. */
function stopGame() {
  const g = game;
  startGame.token = null;
  if (!g) return;
  game = null;
  g.state = 'ended';
  engine?.stop();
  g.input?.disconnect();
  releaseMic();
  if (room && g.round != null) for (const p of g.here) if (p.member) room.send({ result: { round: g.round, score: p.perf.score, left: true } }, p.member);
}

// ---------- Pause ----------
async function pause() {
  if (game?.state !== 'playing' || !engine) return;
  await engine.pause();
  go('pause');
}
// In a room everyone else kept singing: Resume catches up with them.
async function resume() {
  const g = game;
  if (!g || !engine) return;
  go('game');
  await engine.unpause();
  if (g.start.kind === 'room' && room && game === g) playFrom(g, (room.serverNow() - g.start.startAt) / 1000 + 0.15);
}
function renderPause() {
  const g = /** @type {Game} */ (game), now = /** @type {AudioEngine} */ (engine).heardTime();
  setLcd($('lcd-pause'), `<div class="lcd__in"><img class="lcd__cover" src="${g.song.cover}" alt="">
    <div class="lcd__bar"><span><b>Paused</b></span><span>${fmtTime(now)} / ${fmtTime(g.chart.duration)}</span></div>
    <div class="lcd__meta"><p class="lcd__title">${esc(g.song.title)}</p>${segbar(now / g.chart.duration)}</div></div>`);
  // A room's song runs on everyone's devices: restarting it here alone would put this device out of step.
  $('restart').hidden = g.start.kind === 'room';
  /** @type {HTMLInputElement} */ ($('delay')).value = String(settings.latency);
  $('delay-out').textContent = `${settings.latency} ms`;
}

// ---------- Results: a printer feeds out a receipt ----------
/** @typedef {{ name: string, color: string, online: boolean } & ({ kind: 'done', score: number, stars: number, title: string } | { kind: 'singing', score: number } | { kind: 'left', score: number })} Entry */
/** @type {{ g: Game, mine: { p: HereSinger, r: import('./scoring.js').Result }[] } | null} */
let lastResults = null;
let resultsKey = '';
/** @param {HTMLElement} el @param {number} to @param {number} delay @param {number} dur */
function countUp(el, to, delay, dur) {
  if (reduced.matches) { el.textContent = fmt(to); return; }
  el.textContent = '0';
  const t0 = performance.now() + delay;
  const f = (/** @type {number} */ t) => { const p = clamp((t - t0) / dur, 0, 1); el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
/** In a room, friends' scores arrive from their devices as they finish; the receipt reprints as they do.
 * @param {Game} g @param {{ p: HereSinger, r: import('./scoring.js').Result }[]} mine @param {boolean} fresh */
function printResults(g, mine, fresh) {
  lastResults = { g, mine };
  /** @type {Entry[]} */
  const entries = mine.map(({ p, r }) => ({ kind: 'done', name: p.name, color: p.color, online: false, score: r.score, stars: r.stars, title: r.title }));
  for (const p of g.singers) {
    if (p.kind !== 'online') continue;
    const m = room?.view?.members.find((x) => x.id === p.member);
    const r = m?.result?.round === g.round ? m.result : null;
    const base = { name: p.name, color: p.color, online: true };
    // Gone from the room, or told us they stopped: left. Otherwise their final numbers, or their latest score so far.
    entries.push(!m || r?.left ? { ...base, kind: 'left', score: r?.score ?? 0 }
      : r ? { ...base, kind: 'done', score: r.score, stars: r.stars, title: r.title }
        : { ...base, kind: 'singing', score: +(liveOf(g, p)?.score ?? 0) || 0 });
  }
  // Ties rank by name, so every device prints the same order.
  const ranked = entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const key = ranked.map((r) => `${r.name}:${r.score}:${r.kind}`).join('|');
  if (!fresh && key === resultsKey) return;
  resultsKey = key;
  /** @param {Entry} r */
  const verdict = (r) => (r.kind === 'done' ? esc(r.title) : r.kind === 'left' ? 'Left' : 'Still singing');
  /** @param {Entry} r */
  const stars = (r) => `<span class="rc__stars" role="img" aria-label="${r.kind === 'done' ? r.stars : 0} stars">${r.kind === 'done' ? starRow(r.stars) : ''}</span>`;
  $('rc-song').textContent = g.song.title;
  $('rc-meta').textContent = `${DIFFICULTY[g.difficulty].label} · ${g.turns ? 'Take turns' : 'Together'} · ${fmtTime(g.chart.duration)}`;
  const d = new Date();
  $('rc-date').textContent = `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  $('rc-count').textContent = `${ranked.length} singer${ranked.length === 1 ? '' : 's'}`;
  $('rc-rows').innerHTML = ranked.map((r, k) => `<li class="rc__row" style="--c:${r.color}">
    <span class="rc__rank">${k + 1}</span><span class="rc__name"><i class="rc__sw"></i>${esc(r.name)}${r.online ? `<span class="rc__on" title="On their phone">${G.on}<span class="sr">on their phone</span></span>` : ''}</span><span class="rc__score" data-to="${r.score}">${fmt(r.score)}</span>
    <span class="rc__title">${verdict(r)}</span>${stars(r)}</li>`).join('');
  const w = ranked[0];
  if (w) setLcd($('lcd-res'), `<div class="win" style="--c:${w.color}"><div class="lcd__bar"><span><b>1st</b>of ${ranked.length}</span><span>${esc(g.song.title)}</span></div>
    <p class="win__name">${esc(w.name)}</p><p class="win__score">${fmt(w.score)}</p>
    <div class="win__foot"><span>${verdict(w)}</span>${stars(w)}</div></div>`);
  if (!fresh || !w) return;
  const paper = $('paper');
  paper.classList.remove('printing');
  void paper.offsetWidth;
  paper.classList.add('printing');
  $$('.rc__score').forEach((el, k) => countUp(el, Number(el.dataset.to), 260 + k * 90, 520));
  countUp(/** @type {HTMLElement} */ (document.querySelector('.win__score')), w.score, 120, 640);
  // A friend's phone goes back to the room; only the host picks what's next.
  $('again-pick').hidden = isGuest();
  /** @type {HTMLElement} */ ($('again').querySelector('.top')).textContent = isGuest() ? 'Back to the room' : 'Sing again';
}

// ---------- Upload your own song ----------
const STEPS = [
  { key: 'read', label: 'Reading the file' },
  { key: 'separate', label: 'Separating the voice from the music' },
  { key: 'lyrics', label: 'Listening for the words' },
  { key: 'notes', label: 'Finding the notes' },
  { key: 'save', label: 'Saving it on this device' },
];
/** Raw pipeline stages: the step each belongs to, the part of that step it fills (so progress never goes backwards),
 * a note while it runs, and the model it downloads (named once it is done).
 * @type {Record<string, { step: string, from: number, to: number, note?: string, model?: string }>} */
const STAGE = {
  read: { step: 'read', from: 0, to: 1 },
  model: { step: 'separate', from: 0, to: 0.3, model: 'voice' },
  separate: { step: 'separate', from: 0.3, to: 1 },
  'pitch-model': { step: 'lyrics', from: 0, to: 0.1, model: 'melody' },
  pitch: { step: 'lyrics', from: 0.1, to: 0.3, note: 'Tracking the melody' },
  'lyrics-model': { step: 'lyrics', from: 0.3, to: 0.6, model: 'speech' },
  words: { step: 'lyrics', from: 0.6, to: 1, note: 'Writing down the words' },
  notes: { step: 'notes', from: 0, to: 1 },
  save: { step: 'save', from: 0, to: 1 },
};
/** What the upload screen holds: the file, and the song a remake replaces (its id). */
let upload = { file: /** @type {Blob | null} */ (null), replace: /** @type {string | null} */ (null) };
/** @type {AbortController | null} the upload running now */
let importRun = null;
/** @param {Blob} f */
const isMedia = (f) => /^(audio|video)\//.test(f.type) || (f instanceof File && /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|mp4|m4v|mov|mkv|avi|wma|aif|aiff|3gp|flv|wmv)$/i.test(f.name));
const fileName = (/** @type {Blob} */ f) => (f instanceof File ? f.name : '');
let firstRunNote = '';

/** @param {Blob | null} file @param {string | null} replace */
async function openImport(file, replace) {
  upload = { file, replace };
  go('upload');
  const { gpuInfo } = await import('./import/importer.js');
  firstRunNote = (await gpuInfo()) ? 'The first time, this downloads about 700 MB' : 'This browser has no graphics chip access, so it takes a few minutes per minute of song';
  if (screen === 'upload') renderUpload();
}
function renderUpload() {
  const f = upload.file, ok = !!f && isMedia(f), bay = $('bay');
  bay.dataset.state = !f ? 'empty' : ok ? 'file' : 'error';
  $('bay-t').textContent = f ? fileName(f) : 'Drop an audio or video file';
  $('bay-s').textContent = !f ? firstRunNote : ok ? `${(f.size / 1e6).toFixed(1)} MB` : 'Not an audio or video file';
  $('bay-led').classList.toggle('on', !!f);
  $('bay-led').classList.toggle('led--mint', !f || ok);
  /** @type {HTMLElement} */ ($('choose').querySelector('.top')).textContent = f ? 'Choose another' : 'Choose file';
  /** @type {HTMLButtonElement} */ ($('make')).disabled = !ok;
}
/** @param {File | undefined} f */
function takeFile(f) {
  if (!f) return;
  if (screen === 'upload') { upload.file = f; renderUpload(); } else openImport(f, null);
}

/** Each step's LED: done (with any model it downloaded), running (with its progress), or waiting.
 * @param {{ name: string, step: string, p: number | null, note: string, got: Map<string, string[]>, error?: string }} s */
function renderSteps({ name, step, p, note, got, error }) {
  const at = STEPS.findIndex((s) => s.key === step);
  const all = Math.floor(((at + (p ?? 0)) / STEPS.length) * 100);
  setLcd($('lcd-up'), `<div class="lcd__in lcd__in--msg"><div class="lcd__bar"><span><b>${error ? 'That didn’t work' : upload.replace ? 'Remaking it' : 'Making it singable'}</b></span><span>${error ? '' : `${all}%`}</span></div>
    <p class="lcd__title${error ? ' lcd__err' : ''}">${esc(error || name)}</p>${error ? '' : segbar(all / 100)}</div>`);
  $('up-steps').innerHTML = STEPS.map((s, i) => {
    const st = i < at ? 'done' : i === at && !error ? 'run' : 'wait';
    const pct = Math.round((p ?? 0) * 100);
    const right = st === 'done' ? G.done : st === 'run' && p != null ? `<span class="xfer"><span class="xfer__seg">${segs(pct)}</span>${pct}%</span>` : '';
    const models = got.get(s.key) || [];
    const sub = st === 'run' && note ? note : models.length ? `Downloaded the ${models.join(' and ')} model${models.length > 1 ? 's' : ''}. That only happens the first time.` : '';
    return `<li class="ust" data-s="${st}"><i class="led${st === 'done' ? ' led--mint on' : st === 'run' ? ' on blink' : ''}" aria-hidden="true"></i><span class="ust__l">${s.label}</span><span class="ust__r">${right}</span>${sub ? `<span class="ust__sub">${esc(sub)}</span>` : ''}</li>`;
  }).join('');
}

async function runImport() {
  const { file, replace } = upload;
  if (!file || !isMedia(file) || importRun) return;
  const run = new AbortController();
  importRun = run;
  go('upload-progress');
  const name = fileName(file).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || SONGS.find((s) => s.id === replace)?.title || 'Your song';
  // A model counts as downloaded when its download showed progress (a stored one reports done at once).
  /** @type {Map<string, string[]>} */
  const got = new Map();
  /** @type {{ stage: string, step: string, model: string } | null} */
  let fetching = null;
  let shown = { step: 'read', p: 0 }, last = 0;
  /** @param {string} s @param {number} p */
  const stage = (s, p) => {
    const st = STAGE[s];
    if (!st) return;
    if (fetching && s !== fetching.stage) {
      got.set(fetching.step, [...(got.get(fetching.step) || []), fetching.model]);
      fetching = null;
    }
    const downloading = !!st.model && p > 0 && p < 1;
    if (st.model && downloading) fetching = { stage: s, step: st.step, model: st.model };
    const sp = st.from + (st.to - st.from) * clamp(p, 0, 1);
    shown = { step: st.step, p: st.step === shown.step ? Math.max(shown.p, sp) : sp };
    const now = performance.now();
    if (now - last < 120 && p > 0 && p < 1) return;
    last = now;
    const note = downloading ? `Downloading the ${st.model} model (only the first time)` : st.note ?? '';
    if (screen === 'upload-progress' && importRun === run) renderSteps({ name, step: shown.step, p: shown.p, note, got });
  };
  renderSteps({ name, step: 'read', p: 0, note: '', got });
  const t0 = performance.now();
  try {
    const { importSong } = await import('./import/importer.js');
    const rec = await importSong(/** @type {File} */ (file), { lyrics: /** @type {HTMLTextAreaElement} */ ($('lyrics')).value, signal: run.signal, stage });
    stage('save', 0);
    // A remake keeps the old song's place: same id (so a room's pick still finds it) and first upload time.
    if (replace) {
      rec.id = replace;
      rec.createdAt = (await getUserSong(replace))?.createdAt ?? rec.createdAt;
    }
    run.signal.throwIfAborted();
    await saveUserSong(rec);
    const song = userSong(rec);
    const old = SONGS.findIndex((s) => s.id === rec.id);
    if (old >= 0) {
      releaseSong(SONGS[old]);
      SONGS[old] = song;
    } else SONGS.push(song);
    sendLibrary();
    settings.songId = song.id;
    saveSettings();
    if (room?.view?.isHost) room.act('set', { song: song.id }).catch((err) => toast(message(err)));
    /** @type {HTMLTextAreaElement} */ ($('lyrics')).value = '';
    upload = { file: null, replace: null };
    window.__gv.imported = { id: rec.id, lines: rec.chart.lines.length, secs: Math.round((performance.now() - t0) / 1000), where: rec.where, language: rec.chart.language };
    if (screen === 'upload-progress') go('song');
  } catch (err) {
    if (run.signal.aborted) return;
    console.error(err);
    renderSteps({ name, step: shown.step, p: null, note: '', got, error: message(err) });
    window.__gv.importError = message(err);
  } finally {
    if (importRun === run) importRun = null;
  }
}

/** Uploads made by an older version: remake from the stored original, pick the file again (uploads from before files
 * were kept), or play it as it is. A friend's song can only be remade by the friend. @param {Song} song */
async function askRemake(song) {
  const rec = await getUserSong(song.id);
  if (!rec) return go('settings');
  const friend = rec.where === 'friend';
  const line = rec.source ? 'The new version finds the notes and words better'
    : friend ? `Ask ${rec.from || 'your friend'} to remake it and share it again`
      : 'Choose the same file again to remake it';
  setLcd($('lcd-outdated'), `<div class="lcd__in"><img class="lcd__cover" src="${song.cover}" alt="">
    <div class="lcd__bar"><span><b>Made with an older version</b></span></div>
    <div class="lcd__meta"><p class="lcd__title">${esc(song.title)}</p><p class="lcd__by">${esc(line)}</p></div></div>`);
  const remake = $('outdated-remake');
  remake.hidden = friend && !rec.source;
  /** @type {HTMLElement} */ (remake.querySelector('.top')).textContent = rec.source ? 'Remake it' : 'Choose the file';
  remake.onclick = () => {
    if (rec.source) { upload = { file: rec.source, replace: song.id }; runImport(); } else openImport(null, song.id);
  };
  $('outdated-play').onclick = () => { outdatedOk = true; toSettings(); };
  go('outdated');
}

// ---------- Wiring ----------
const encSong = makeEncoder($('enc-song'), { count: () => catalog().length, get: () => selIndex(), set: selectSong, onEnter: toSettings });
const mode = new Slide($('mode'), (v) => setMode(/** @type {Mode} */ (v)));
const diff = new Slide($('sw-diff'), (v) => {
  settings.difficulty = DIFFS[+v];
  saveSettings();
  if (room?.view?.isHost) room.act('set', { difficulty: settings.difficulty }).catch((err) => toast(message(err)));
});
// Speakers: the mic opens with echo cancellation at the next song, and the original vocal starts off, since out loud it
// sings your notes into your mic (turn it back up if you like).
const out = new Slide($('sw-out'), (v) => {
  settings.speakers = v === '1';
  if (settings.speakers) { settings.guide = 'off'; vocal.set('0'); }
  saveSettings();
});
const vocal = new Slide($('sw-vocal'), (v) => { settings.guide = GUIDES[+v]; saveSettings(); });

// With friends online, the room starts the song on every device at once.
function sing() {
  if (room?.view && remoteHere()) {
    if (!room.view.isHost || starting) return;
    starting = true;
    syncSing();
    room.act('start', { song: selectedId(), mode: roomMode(), difficulty: settings.difficulty })
      .catch((err) => toast(message(err)))
      .finally(() => { starting = false; if (screen === 'settings') syncSing(); });
    return;
  }
  startGame({ kind: 'local' });
}

document.addEventListener('click', (e) => {
  const t = /** @type {HTMLButtonElement | null} */ (/** @type {Element} */ (e.target).closest('button'));
  if (!t || t.disabled) return;
  if (t.id === 'latch-words') { settings.lyrics = !settings.lyrics; saveSettings(); if (settings.lyrics) ensureChecker(languageOf(selectedSong())); syncWords(); }
  else if (t.id === 'upload-btn') openImport(null, null);
  else if (t.id === 'choose') $('file').click();
  else if (t.id === 'make') runImport();
  else if (t.id === 'sing') sing();
  else if (t.id === 'pause-btn') pause();
  else if (t.id === 'resume') resume();
  else if (t.id === 'restart') { if (game) startGame(game.start); }
  else if (t.id === 'quit') { if (game) { stopGame(); go(isGuest() ? 'guest' : 'song'); } }
  else if (t.id === 'again') go(isGuest() ? 'guest' : 'settings');
  else if (t.id === 'again-pick') go('song');
  else if (t.id === 'invite-btn') copyInvite(t);
  else if (t.dataset.pick != null) { const list = catalog(), k = list.findIndex((s) => s.id === t.dataset.pick); selectSong(k, Math.sign(k - selIndex(list))); encSong.render(); }
  else if (t.dataset.add != null) addSinger();
  else if (t.dataset.remove != null) removeSinger(Number(t.dataset.remove));
  else if (t.dataset.back != null) back();
  else if (t.dataset.go === 'singers' && screen === 'title') { ensureEngine(); const code = roomInLink(); if (code && !room) joinRoom(code); else go(room && isGuest() ? 'guest' : 'singers'); }
  else if (t.dataset.go === 'settings') toSettings();
  else if (t.dataset.go) go(t.dataset.go);
});
$('file').addEventListener('change', (e) => { const inp = /** @type {HTMLInputElement} */ (e.target); takeFile(inp.files?.[0]); inp.value = ''; });
$('bay').addEventListener('click', (e) => { if (!(/** @type {Element} */ (e.target)).closest('button')) $('file').click(); });
$('delay').addEventListener('input', (e) => {
  settings.latency = Number(/** @type {HTMLInputElement} */ (e.target).value);
  $('delay-out').textContent = `${settings.latency} ms`;
  saveSettings();
  if (game?.input) game.input.latency = settings.latency / 1000;
});

// Names: typed straight into the channel. A cleared name keeps the last one when you leave the box.
/** @param {EventTarget | null} t */
const nameBox = (t) => (t instanceof HTMLInputElement && t.matches('.namebox input') ? t : null);
document.addEventListener('focusin', (e) => { const inp = nameBox(e.target); if (inp) inp.dataset.prev = inp.value; });
document.addEventListener('input', (e) => {
  const inp = nameBox(e.target);
  const p = inp && settings.players[Number(inp.dataset.singer)];
  if (!inp || !p || !inp.value.trim()) return;
  p.name = inp.value.trim();
  saveSettings();
  const seat = room?.seats[Number(inp.dataset.singer)];
  if (seat) room?.send({ name: p.name }, seat.id);
  inp.closest('.ch')?.querySelector('[data-remove]')?.setAttribute('aria-label', `Remove ${p.name}`);
});
document.addEventListener('focusout', (e) => {
  const inp = nameBox(e.target);
  if (inp && !inp.value.trim()) inp.value = inp.dataset.prev || settings.players[Number(inp.dataset.singer)]?.name || 'Singer';
});

document.addEventListener('keydown', (e) => {
  const t = /** @type {HTMLElement} */ (e.target);
  const inp = nameBox(t);
  if (inp) {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    else if (e.key === 'Escape') { inp.value = inp.dataset.prev || ''; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.blur(); }
    return;
  }
  if (t.matches?.('textarea') || e.repeat) return;
  if (screen === 'game' && (e.key === 'Escape' || e.key === 'p')) { e.preventDefault(); pause(); return; }
  const key = t.closest?.('.key');
  if (key && (e.key === ' ' || e.key === 'Enter')) key.classList.add('is-down');
  if (e.key === 'Escape') { back(); return; }
  // Enter presses the screen's main key, unless focus is on a control that has its own use for Enter.
  if (e.key === 'Enter' && !t.closest?.('button, a, input, [role=slider]')) {
    const k = /** @type {HTMLButtonElement | null} */ (device.querySelector('.screen.is-on .key--sun:not(:disabled)'));
    if (!k) return;
    e.preventDefault();
    k.classList.add('is-down');
    setTimeout(() => { k.classList.remove('is-down'); k.click(); }, 110);
    return;
  }
  if (screen === 'song' && /^Arrow/.test(e.key) && !t.closest?.('input, [role=slider], .slide')) { e.preventDefault(); encSong.step(e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1); }
});
document.addEventListener('keyup', () => $$('.key.is-down').forEach((k) => k.classList.remove('is-down')));

// Drag a file anywhere onto the device while picking a song or in the upload screen.
let dragDepth = 0;
const dropHere = () => (screen === 'song' || screen === 'upload') && !isGuest();
addEventListener('dragenter', (e) => { e.preventDefault(); if (dropHere() && ++dragDepth) device.classList.add('is-drop'); });
addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = dropHere() ? 'copy' : 'none'; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; device.classList.remove('is-drop'); } });
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; device.classList.remove('is-drop'); if (dropHere()) takeFile(e.dataTransfer?.files[0]); });

// ---------- Boot ----------
// Built-in songs' credits and lengths come from their charts.
for (const s of SONGS) {
  if (s.kind !== 'builtin') continue;
  loadChart(s).then((c) => { credit.set(s.id, { by: c.credit || '', len: fmtTime(c.duration) }); if (screen === 'song') renderSongList(); }).catch(() => {});
}
loadUserSongs();
go('title');
// Test hook: ?singer=<audio url> makes room games sing that recording instead of the mic.
const roomSinger = params.get('singer');
window.__gv.songs = () => loadUserSongs().then(() => SONGS.map((s) => ({ id: s.id, title: s.title, upload: s.kind === 'upload' })));

// Automation and test hook: ?autoplay=<song id>&input=demo|mic|<audio url>&lyrics=1&difficulty=normal&players=Ann,Ben
// (players makes the recorded singer's part go round those names, two lines each).
const autoplay = params.get('autoplay');
if (autoplay) {
  const input = params.get('input') || 'demo';
  /** @type {Start} */
  const start = input === 'mic' ? { kind: 'local' } : {
    kind: 'test',
    song: autoplay,
    voice: input,
    names: params.get('players')?.split(',') || [params.get('name') || 'Test singer'],
    audible: params.get('audible') === '1',
    lyrics: params.get('lyrics') === '1',
    difficulty: DIFFS.includes(/** @type {Difficulty} */ (params.get('difficulty'))) ? /** @type {Difficulty} */ (params.get('difficulty')) : 'normal',
    guide: GUIDES.includes(/** @type {Guide} */ (params.get('guide'))) ? /** @type {Guide} */ (params.get('guide')) : 'soft',
  };
  loadUserSongs().then(() => {
    if (haveSong(autoplay)) settings.songId = autoplay;
    window.__gv.start = () => startGame(start);
    if (params.get('wait') !== '1') ensureEngine().then(() => startGame(start));
  });
}
