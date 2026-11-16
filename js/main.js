import { AudioEngine } from './audio-engine.js';
import { VoiceInput, openMic } from './voice-input.js';
import { Performance, DIFFICULTY } from './scoring.js';
import { StageRenderer, shownPitch } from './renderer.js';
import { LyricChecker, lyricMatch } from './lyric-check.js';
import { SONGS, loadChart, userSong, releaseSong, isOutdated } from './songs.js';
import { listUserSongs, getUserSong, saveUserSong } from './import/song-store.js';
import { packSong, unpackSong } from './share.js';
import { SERVER } from './import/server.js';
import { Room, inviteLink, roomInLink } from './room.js';

// The game is one instrument: a device face with screens for who's singing, the song, the settings, the song itself
// and the results. People singing on this device and friends who joined through the invite link share one channel
// rack; a friend's phone shows its own small screen (guest) until the host presses Sing.

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const fmtTime = (s) => `${Math.floor(Math.max(0, s) / 60)}:${pad(Math.floor(Math.max(0, s) % 60))}`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const phone = matchMedia('(max-width: 1180px)');

const COLORS = ['#6EF3FF', '#FF77B7', '#B8FF6B', '#FFB547', '#A98BFF', '#FF8A5B'];
const color = (i) => COLORS[i % COLORS.length];
const MAX_SINGERS = 6;
const MAX_MICS_HERE = 2; // singing together needs a mic per singer on this device
const LINES_PER_TURN = 2;
const DIFFS = ['easy', 'normal', 'hard'];
const GUIDES = ['off', 'soft', 'full'];
const GUIDE_LEVEL = { off: 0, soft: 0.28, full: 0.9 };
const params = new URLSearchParams(location.search);
const G = {
  plus: '<svg class="g" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  minus: '<svg class="g" viewBox="0 0 24 24"><path d="M5.5 12h13"/></svg>',
  link: '<svg class="g" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.2 1.2M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.2-1.2"/></svg>',
  on: '<svg class="g" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/></svg>',
  done: '<svg class="g" viewBox="0 0 24 24" aria-label="Done"><path d="M5.5 12.5 10 17l8.5-9.5"/></svg>',
};
const INVITE_LEGEND = `${G.link}<span>Copy link to invite online friends</span>`;

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
  { players: [{ name: 'Player 1', deviceId: '' }], mode: 'together', difficulty: 'normal', guide: 'soft', speakers: false, lyrics: true, latency: 0, songId: 'twinkle' },
  store.get('settings', {}),
);
// Member ids of this device's seats in a room live only as long as the room; they are never stored.
const saveSettings = () => store.set('settings', { ...settings, players: settings.players.map(({ name, deviceId }) => ({ name, deviceId })) });

// ---------- State ----------
let engine = null;
let renderer = null;
let checker = null;
let game = null;
let room = null;
let screen = '';
let lastGameOpts = null;
const streams = [];
const monitors = [];
window.__gv = { results: null, status: 'boot' };
const device = $('device');

function ensureEngine() {
  if (!engine) engine = new AudioEngine();
  return engine.resume().then(() => engine);
}

// One speech model at a time: English-only for built-in songs (language null), the multilingual one for uploads.
function ensureChecker(language = selectedSong()?.chartData?.language ?? null) {
  if (checker && checker.language !== language) {
    checker.dispose();
    checker = null;
  }
  if (!checker) {
    checker = new LyricChecker(language, (s) => {
      checker.state = s;
      if (screen === 'settings') syncWords();
      if (s.status === 'error') toast(`The words check isn't available: ${s.message}`);
    });
  }
  checker.load().catch(() => {});
  return checker;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}

// ---------- Small builders ----------
const svgURI = (s) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
const seeded = (n) => () => (n = (n * 16807) % 2147483647) / 2147483647;
// A friend's song that isn't on this device yet has no art here: rings in the song's own colours.
function coverFor(title, accents = []) {
  let h = 7;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  const rnd = seeded(h || 7);
  const bg = '#141414', fg = accents[1] || '#fffef9', acc = accents[0] || '#ffd23f';
  let s = `<rect width="640" height="640" fill="${bg}"/>`;
  const n = 4 + Math.floor(rnd() * 4);
  for (let i = n; i > 0; i--) s += `<circle cx="${200 + rnd() * 240}" cy="${200 + rnd() * 240}" r="${i * 46}" fill="none" stroke="${i === 1 ? acc : fg}" stroke-width="${i === 1 ? 46 : 8}" opacity="${i === 1 ? 1 : 0.7}"/>`;
  return svgURI(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">${s}</svg>`);
}
const segs = (pct) => { const lit = Math.floor(pct / 10); return Array.from({ length: 10 }, (_, i) => `<i class="${i < lit ? 'on' : i === lit ? 'now' : ''}"></i>`).join(''); };
const segbar = (frac) => `<div class="segbar">${Array.from({ length: 20 }, (_, i) => `<i class="${i < frac * 20 ? 'on' : ''}"></i>`).join('')}</div>`;
const starRow = (n) => Array.from({ length: 5 }, (_, i) => {
  const fill = n >= i + 1 ? 'currentColor' : n > i ? 'url(#half)' : 'none';
  return `<svg viewBox="0 0 24 24"><use href="#star" fill="${fill}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}).join('');
function setLcd(el, html, dir = 0) {
  const scr = el.querySelector('.lcd__screen');
  scr.innerHTML = html;
  if (dir && !reduced.matches) scr.firstElementChild?.animate([{ opacity: 0, transform: `translateX(${dir * 10}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
// A filling meter gets as many LEDs as fit its column.
function fitMeters() { for (const m of $$('.screen.is-on .meter--fill')) m.innerHTML = '<i class="led"></i>'.repeat(phone.matches ? 10 : clamp(Math.floor((m.clientWidth - 15) / 14), 8, 28)); }
addEventListener('resize', () => { if (screen === 'singers' || screen === 'guest') fitMeters(); });

// ---------- Songs: built in, uploaded on this device, and friends' songs in the room ----------
let userSongsLoaded = null;
function loadUserSongs() {
  userSongsLoaded ||= listUserSongs()
    .then((recs) => recs.forEach((r) => SONGS.push(userSong(r))))
    .catch((err) => console.warn('Could not read your saved songs', err));
  return userSongsLoaded;
}
const credit = new Map(); // song id -> chart credit, once its chart has loaded
const haveSong = (id) => SONGS.some((s) => s.id === id);
const builtIn = (id) => SONGS.some((s) => s.id === id && !s.user);

// Every song this device can pick: what's here, then songs friends in the room have that aren't here yet.
function catalog() {
  const list = SONGS.map((s) => ({
    id: s.id, song: s, title: s.title, cover: s.cover, yours: !!s.user,
    by: s.user ? s.artist || '' : credit.get(s.id) || '',
    len: s.chartData ? fmtTime(s.chartData.duration) : credit.has(`${s.id}:len`) ? credit.get(`${s.id}:len`) : '',
  }));
  const v = room?.view;
  if (v) {
    for (const m of v.members.filter((x) => x.here && !v.mine.includes(x.id))) {
      for (const e of m.library) {
        if (list.some((x) => x.id === e.id)) continue;
        const t = transfers.get(e.id);
        list.push({ id: e.id, title: e.title, by: e.artist, cover: coverFor(e.title, e.accents), len: e.duration ? fmtTime(e.duration) : '', from: m.name, pct: Math.round((t?.p ?? 0) * 100) });
      }
    }
  }
  return list;
}
const selectedId = () => room?.view?.room.song || settings.songId;
const selectedSong = () => SONGS.find((s) => s.id === selectedId()) || SONGS[0];
function selIndex(list = catalog()) {
  const i = list.findIndex((x) => x.id === selectedId());
  return i < 0 ? 0 : i;
}

const lcdSong = (s, i, total) => `<div class="lcd__in">
  <img class="lcd__cover" src="${s.cover}" alt="">
  <div class="lcd__bar"><span><span><b>${pad(i + 1)}</b>/${pad(total)}</span></span><span>${s.yours ? '<i class="tag">Yours</i>' : ''}${s.from ? `<i class="tag">From ${esc(s.from)}</i>` : ''}${s.len ? `<span>${s.len}</span>` : ''}${s.from ? `<span>${s.pct}%</span>` : ''}</span></div>
  <div class="lcd__meta"><p class="lcd__title">${esc(s.title)}</p><p class="lcd__by">${esc(s.by)}</p></div></div>`;
const trackRow = (s, k, cur) => `<li><button class="trk${s.from ? ' is-wait' : ''}" type="button" data-pick="${esc(s.id)}"${cur ? ' aria-current="true"' : ''}>
  <i class="led${cur ? ' on' : ''}"></i><span class="trk__n">${k + 1}</span>
  <span class="trk__txt"><span class="trk__t">${esc(s.title)}</span><span class="trk__by">${esc(s.by)}${s.from ? ` · from ${esc(s.from)}` : ''}</span></span>
  <span class="trk__r">${s.yours ? '<i class="tag">Yours</i>' : ''}${s.from ? `<i class="tag tag--o trk__from">From ${esc(s.from)}</i>` : ''}${s.from && s.pct > 0 ? `<span class="xfer"><span class="xfer__seg">${segs(s.pct)}</span>${s.pct}%</span>` : ''}${s.len ? `<span class="trk__len">${s.len}</span>` : ''}</span></button></li>`;

// ---------- Slide switches ----------
const slides = new Map();
function initSlide(root, onChange) {
  const radios = $$('input[type=radio]', root), track = root.querySelector('.slide__track');
  const sync = () => root.style.setProperty('--i', Math.max(0, radios.findIndex((r) => r.checked)));
  const pick = (x) => {
    const r = track.getBoundingClientRect();
    const i = clamp(Math.floor(((x - r.left) / r.width) * radios.length), 0, radios.length - 1);
    if (radios[i].disabled || radios[i].checked) return;
    radios[i].checked = true;
    radios[i].dispatchEvent(new Event('change', { bubbles: true }));
  };
  radios.forEach((r) => r.addEventListener('change', () => { sync(); onChange(r.value); }));
  track.addEventListener('pointerdown', (e) => {
    if (radios.every((r) => r.disabled)) return;
    track.setPointerCapture(e.pointerId);
    root.classList.add('is-drag');
    pick(e.clientX);
    radios.find((r) => r.checked)?.focus({ preventScroll: true });
  });
  track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) pick(e.clientX); });
  const end = () => root.classList.remove('is-drag');
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  sync();
  slides.set(root, { sync, radios });
}
const setRadio = (root, value) => { const api = slides.get(root); api.radios.forEach((r) => { r.checked = r.value === String(value); }); api.sync(); };

// ---------- Rotary encoder with detents ----------
// The detents share at most 300 degrees, so a long list still fits; with many songs only every few ticks is numbered.
function makeEncoder(el, { count, get, set, onEnter }) {
  const stepOf = () => Math.min(30, 300 / Math.max(1, count() - 1));
  const knob = el.querySelector('.enc__knob'), seat = el.querySelector('.enc__seat'), ticks = el.querySelector('.enc__ticks');
  let acc = 0, last = 0, drag = false, wheel = 0, wheelAt = 0;
  const angle = (e) => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
  const render = (tension = 0) => {
    const n = count(), i = get();
    knob.style.setProperty('--a', `${(i - (n - 1) / 2) * stepOf() + tension}deg`);
    el.setAttribute('aria-valuemax', n);
    el.setAttribute('aria-valuenow', i + 1);
  };
  const drawTicks = () => {
    const n = count(), every = Math.ceil(n / 12);
    let s = '';
    for (let i = 0; i < n; i++) {
      const a = ((i - (n - 1) / 2) * stepOf()) * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a);
      s += `<line x1="${100 + 84 * sin}" y1="${100 - 84 * cos}" x2="${100 + 91 * sin}" y2="${100 - 91 * cos}"/>`;
      if (i % every === 0 || i === n - 1) s += `<text x="${100 + 99 * sin}" y="${100 - 99 * cos}" data-i="${i}">${i + 1}</text>`;
    }
    ticks.innerHTML = s;
  };
  const go = (i) => {
    const n = count(), cur = get(), next = clamp(i, 0, n - 1);
    if (next === cur) return false;
    set(next, Math.sign(next - cur));
    if (!reduced.matches) { seat.classList.remove('seat'); void seat.offsetWidth; seat.classList.add('seat'); }
    return true;
  };
  const step = (d) => { go(get() + d); render(); };
  el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); last = angle(e); acc = 0; el.classList.add('is-drag'); el.focus({ preventScroll: true }); });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const a = angle(e);
    let d = a - last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    last = a;
    acc += d;
    const detent = stepOf();
    while (acc > detent * 0.6) { if (go(get() + 1)) acc -= detent; else { acc = Math.min(acc, 10); break; } }
    while (acc < -detent * 0.6) { if (go(get() - 1)) acc += detent; else { acc = Math.max(acc, -10); break; } }
    render(clamp(acc, -10, 10) * 0.55);
  });
  const end = () => { if (!drag) return; drag = false; acc = 0; el.classList.remove('is-drag'); render(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.timeStamp - wheelAt > 300) wheel = 0;
    wheelAt = e.timeStamp;
    wheel += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
    if (Math.abs(wheel) >= 24) { step(wheel > 0 ? 1 : -1); wheel = 0; }
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft') { e.preventDefault(); step(k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1); }
    else if (k === 'Home' || k === 'End') { e.preventDefault(); go(k === 'Home' ? 0 : count() - 1); render(); }
    else if (k === 'Enter') { e.preventDefault(); onEnter(); }
  });
  return { render, step, refresh() { drawTicks(); render(); } };
}

// ---------- Screens ----------
const STEP_OF = { singers: 'singers', song: 'song', upload: 'song', 'upload-progress': 'song', outdated: 'song', settings: 'settings' };
const enter = {
  title() { const g = device.querySelector('.arm__g'); g.classList.remove('swing'); void g.getBBox(); g.classList.add('swing'); },
  singers() { renderSingers(); connectMonitors(); },
  song() { renderSongList(); },
  settings() { renderSettings(); if (settings.lyrics) ensureChecker(); },
  guest() { renderGuest(); connectMonitors(); },
  game() {},
  pause() { renderPause(); },
  upload() { renderUpload(); },
  'upload-progress'() {},
  outdated() {},
  results() {},
};
function go(name) {
  const prev = screen;
  screen = name;
  device.dataset.screen = name;
  $$('.screen').forEach((s) => s.classList.toggle('is-on', s.dataset.screen === name));
  $$('.step').forEach((b) => {
    const cur = b.dataset.step === STEP_OF[name];
    b.classList.toggle('is-cur', cur);
    if (cur) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.querySelector('.led').classList.toggle('on', cur);
  });
  if (!['singers', 'guest'].includes(name)) stopMonitors();
  enter[name]();
  if (prev && prev !== name) device.querySelector('.screen.is-on').focus({ preventScroll: true });
  window.__gv.screen = name;
}
const BACK = { singers: 'title', song: 'singers', settings: 'song', upload: 'song', outdated: 'song' };
function back() {
  if (screen === 'guest') return leaveRoom();
  if (screen === 'game') return pause();
  if (screen === 'pause') return resume();
  if (screen === 'upload-progress') { importAbort?.abort(); return go('upload'); }
  if (BACK[screen]) go(BACK[screen]);
}

// ---------- Singers: one channel rack for people on this device and friends online ----------
// Without a room the channels are this device's singers. In a room they are the room's people in the order they
// joined, which is also the order lines go round when taking turns; this device's seats are its singers.
function channels() {
  const v = room?.view;
  if (!v) return settings.players.map((p, i) => ({ key: `l${i}`, local: i, name: p.name, c: i }));
  return v.members.filter((m) => m.here).map((m) => {
    const local = settings.players.findIndex((p) => p.seat === m.id);
    return { key: m.id, member: m, local: local < 0 ? null : local, name: local < 0 ? m.name : settings.players[local].name, c: m.color, host: m.id === v.room.host };
  });
}
const localPlayers = () => (room?.view ? settings.players.filter((p) => p.seat) : settings.players);
const roomMode = () => room?.view?.room.mode || settings.mode;

const rackKey = (list) => list.map((s) => `${s.key}:${s.local == null ? s.name : ''}`).join('|');
function renderSingers(fresh) {
  const list = channels(), rows = [];
  renderSingers.ids = list.map((s) => s.key);
  const canRemove = (s) => s.local != null && localPlayers().length > 1;
  list.forEach((s, i) => {
    const online = s.local == null;
    const name = online
      ? `<span class="namebox"><span class="namebox__name">${esc(s.name)}</span><span class="namebox__on">${G.on}On their phone</span></span>`
      : `<label class="namebox"><input class="namebox__name" type="text" value="${esc(s.name)}" maxlength="18" spellcheck="false" autocomplete="off" data-singer="${s.local}" aria-label="Singer ${i + 1} name"></label>`;
    const anim = fresh?.has(s.key) ? (online ? ' is-join' : ' is-new') : '';
    rows.push(`<li class="ch${online ? ' is-online' : ''}${anim}" style="--c:${color(s.c)}">
    <span class="ch__no">${pad(i + 1)}</span><i class="ch__sw"></i>${name}
    <span class="meter meter--fill" data-meter="${esc(s.key)}" aria-hidden="true"></span>
    ${online ? '<span></span>' : `<button class="key key--round" type="button" data-remove="${s.local}" aria-label="Remove ${esc(s.name)}"${canRemove(s) ? '' : ' disabled'}><span class="top">${G.minus}</span></button>`}</li>`);
  });
  if (list.length < MAX_SINGERS) rows.push(`<li class="ch ch--add"><span class="ch__no">${pad(list.length + 1)}</span><span></span>
    <span class="addwrap"><button class="key key--round" type="button" data-add aria-label="Add singer"><span class="top">${G.plus}</span></button><span class="silk">Add singer</span></span></li>`);
  for (let i = list.length + 1; i < MAX_SINGERS; i++) rows.push(`<li class="ch ch--empty" aria-hidden="true"><span class="ch__no">${pad(i + 1)}</span></li>`);
  $('singer-rows').innerHTML = rows.join('');
  renderSingers.keys = rackKey(list);
  fitMeters();
  syncMode();
}
// Together needs one mic per singer on this device (2 at most); friends online bring their own phone.
function syncMode() {
  const n = channels().length, local = localPlayers().length, sw = $('mode');
  const [together, turns] = slides.get(sw).radios;
  const host = !room?.view || room.view.isHost;
  together.disabled = n < 2 || local > MAX_MICS_HERE || !host;
  turns.disabled = n < 2 || !host;
  if (local > MAX_MICS_HERE && roomMode() !== 'turns') setMode('turns');
  sw.classList.toggle('is-disabled', n < 2);
  sw.classList.toggle('is-max', local > MAX_MICS_HERE);
  setRadio(sw, roomMode());
}
function setMode(v) {
  settings.mode = v;
  saveSettings();
  if (room?.view?.isHost) room.act('set', { mode: v }).catch((err) => toast(err.message));
}
async function addSinger() {
  if (channels().length >= MAX_SINGERS) return;
  let k = 1;
  while (settings.players.some((p) => p.name === `Player ${k}`)) k++;
  const p = { name: `Player ${k}`, deviceId: '' };
  settings.players.push(p);
  saveSettings();
  if (room) p.seat = await room.addSeat(p.name).catch((err) => { toast(err.message); return undefined; });
  renderSingers(new Set([p.seat || `l${settings.players.length - 1}`]));
  connectMonitors();
  ($('singer-rows').querySelector('[data-add]') || $('singer-rows').querySelector(`[data-singer="${settings.players.length - 1}"]`))?.focus({ preventScroll: true });
}
function removeSinger(i) {
  if (localPlayers().length < 2) return;
  const [p] = settings.players.splice(i, 1);
  if (p.seat) room?.removeSeat(p.seat);
  saveSettings();
  renderSingers();
  connectMonitors();
}

// The first copy makes the room: this device's singers each take a seat, and friends who open the link take the
// next free channels.
async function copyInvite(btn) {
  const top = btn.querySelector('.top');
  try {
    if (!room) {
      await openRoom();
      renderSingers();
    }
    const ok = await navigator.clipboard.writeText(inviteLink(room.main.code)).then(() => true, () => false);
    top.innerHTML = ok ? '<i class="led led--mint on"></i><span>Copied</span>' : `<i class="led on"></i><span>${esc(inviteLink(room.main.code))}</span>`;
  } catch (err) {
    top.innerHTML = '<i class="led on"></i><span>Couldn’t make a room</span>';
    toast(err.message || String(err));
  }
  clearTimeout(copyInvite.timer);
  copyInvite.timer = setTimeout(() => { top.innerHTML = INVITE_LEGEND; }, 2400);
}

// ---------- Live mic LEDs ----------
// This device's channels show its microphones; a friend's channel shows the level their phone sends with each poll.
const peaks = new Map();
let lastMeter = 0, lastLevelSent = 0;
function micLevel(local) {
  const m = monitors[roomMode() === 'turns' ? 0 : local];
  return m ? m.level : 0;
}
function meters(t) {
  requestAnimationFrame(meters);
  if (t - lastMeter < (reduced.matches ? 180 : 60)) return;
  lastMeter = t;
  monitors.forEach((m) => m.drain());
  const list = screen === 'singers' || screen === 'guest' ? channels() : [];
  for (const m of $$('.screen.is-on .meter[data-meter]')) {
    const s = list.find((x) => x.key === m.dataset.meter);
    if (!s) continue;
    const lvl = s.local != null ? micLevel(s.local) : clamp(+s.member.live?.level || 0, 0, 1);
    const L = m.children, n = L.length;
    let v = peaks.get(m.dataset.meter);
    if (!v) peaks.set(m.dataset.meter, (v = { peak: 0, hold: 0 }));
    const lit = Math.round(clamp(lvl * 1.25, 0, 1) * n);
    if (lit >= v.peak) { v.peak = lit; v.hold = t + 650; } else if (t > v.hold) { v.peak = Math.max(lit, v.peak - 1); v.hold = t + 80; }
    for (let i = 0; i < n; i++) L[i].classList.toggle('on', i < lit || (v.peak > 1 && i === v.peak - 1));
  }
  // Friends see this device's levels too, at the pace of the room's polls.
  if (room && list.length && t - lastLevelSent > 300) {
    lastLevelSent = t;
    for (const s of list) if (s.local != null && s.member) room.setLive({ level: Math.round(micLevel(s.local) * 20) / 20 }, s.member.id);
  }
}
requestAnimationFrame(meters);

async function connectMonitors() {
  stopMonitors();
  try {
    await ensureEngine();
    const mics = roomMode() === 'turns' ? 1 : Math.min(MAX_MICS_HERE, localPlayers().length);
    for (let i = 0; i < mics; i++) {
      const m = new VoiceInput(engine, { stream: await getStream(i) });
      await m.connect();
      monitors.push(m);
    }
  } catch (err) {
    stopMonitors();
    micError(err);
  }
}
function stopMonitors() {
  monitors.splice(0).forEach((m) => m.disconnect());
}
async function getStream(i) {
  const want = settings.players[i]?.deviceId || '';
  const have = streams[i];
  if (have && have.deviceId === want && have.speakers === settings.speakers && have.stream.active) return have.stream;
  have?.stream.getTracks().forEach((t) => t.stop());
  const stream = await openMic(want, settings.speakers);
  streams[i] = { deviceId: want, speakers: settings.speakers, stream };
  return stream;
}
function micError(err) {
  if (err?.name === 'NotAllowedError') toast('Microphone blocked. Allow it in the address bar, then reload.');
  else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') toast('No microphone found. Plug one in and try again.');
  else toast(`Microphone error: ${err?.message || err}`);
}

// ---------- Song ----------
let encSong;
function renderSongList() {
  const list = catalog(), sel = selIndex(list);
  $('tracks-song').innerHTML = list.map((s, k) => trackRow(s, k, k === sel)).join('');
  encSong.refresh();
  markTracks(sel);
  setLcd($('lcd-song'), lcdSong(list[sel], sel, list.length));
  $('enc-song').setAttribute('aria-valuetext', list[sel].title);
  renderSongList.key = list.map((s) => `${s.id}:${s.pct ?? ''}:${s.by}:${s.len}`).join('|');
}
function markTracks(sel) {
  $$('.trk', $('tracks-song')).forEach((b, k) => {
    const cur = k === sel;
    if (cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    b.querySelector('.led').classList.toggle('on', cur);
  });
  $$('.enc__ticks text', $('enc-song')).forEach((t) => t.classList.toggle('cur', +t.dataset.i === sel));
  // The picked song's row stays in view in a long list (only the list scrolls, never the page).
  const list = $('tracks-song'), row = list.children[sel];
  if (row && list.scrollHeight > list.clientHeight) {
    const top = row.offsetTop - list.offsetTop, bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
}
function selectSong(i, dir) {
  const list = catalog(), s = list[i];
  settings.songId = s.id;
  saveSettings();
  if (room?.view?.isHost) room.act('set', { song: s.id }).catch((err) => toast(err.message));
  markTracks(i);
  setLcd($('lcd-song'), lcdSong(s, i, list.length), dir);
  $('enc-song').setAttribute('aria-valuetext', s.title);
}
// An upload made by an older version asks, each time it's picked, whether to remake it first.
let outdatedOk = false;
function toSettings() {
  const s = selectedSong();
  if (haveSong(selectedId()) && isOutdated(s) && !outdatedOk) return askRemake(s);
  outdatedOk = false;
  go('settings');
}

// ---------- Settings ----------
function renderSettings() {
  const list = catalog(), i = selIndex(list), s = list[i];
  setLcd($('lcd-set'), lcdSong(s, i, list.length));
  setRadio($('sw-diff'), DIFFS.indexOf(settings.difficulty));
  setRadio($('sw-out'), settings.speakers ? 1 : 0);
  setRadio($('sw-vocal'), GUIDES.indexOf(settings.guide));
  syncWords();
  syncSing();
}
// Sing waits for a friend's song to arrive on every device in the room.
function syncSing() {
  const v = room?.view, list = catalog(), s = list[selIndex(list)];
  let note = '';
  if (s.from) note = `${s.title} arriving · ${s.pct}%`;
  else if (v && remoteHere() && v.room.song) {
    const { missing } = songHolders(v, v.room.song);
    if (missing.length) note = `Sending ${s.title} · ${missing.map((m) => m.name).join(', ')}`;
  }
  $('sing').disabled = !!note || (v && !v.isHost);
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
let roomPlayed = 0;
const transfers = new Map(); // song id -> { dir: 'send' | 'get', p?, from?, error? } for transfers this device runs
const myLibrary = () => SONGS.filter((s) => s.user).map((s) => ({ id: s.id, title: s.title, artist: s.artist, duration: s.chartData.duration, language: s.chartData.language, accents: [s.accent, s.accent2] }));
const sendLibrary = () => room?.send({ library: myLibrary() });
const remoteHere = () => room?.view?.members.some((m) => m.here && !room.view.mine.includes(m.id));

// Who in the room has the picked song, and who still needs it. This device's seats all have what it has.
function songHolders(view, id) {
  const here = view.members.filter((m) => m.here);
  const has = (m) => (view.mine.includes(m.id) ? haveSong(id) : builtIn(id) || m.library.some((e) => e.id === id));
  return { holders: here.filter(has), missing: here.filter((m) => !has(m)) };
}

// The first person here who has the picked song sends it once; everyone without it fetches it when it's sent.
function runTransfers(view) {
  const id = view.room.song;
  if (!id || builtIn(id) || transfers.has(id)) return;
  const { holders, missing } = songHolders(view, id);
  if (!missing.length || !holders.length) return;
  if (haveSong(id)) {
    if (view.mine.includes(holders[0].id) && !room.live.sent?.[id]) sendSong(id);
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
    toast(`Sending the song failed: ${t.error}`);
  }
}
async function getSong(id, sender) {
  const t = { dir: 'get', from: sender.name, p: 0 };
  transfers.set(id, t);
  const xfer = (p) => {
    t.p = p;
    room?.setLive({ xfer: { id, dir: 'get', p: Math.round(p * 100) / 100 } });
    refreshRoomScreens();
  };
  try {
    xfer(0);
    const rec = await unpackSong(await room.download(id, sender.live.sent[id], xfer), sender.name, id);
    await saveUserSong(rec);
    SONGS.push(userSong(rec));
    sendLibrary();
    room?.setLive({ xfer: null });
    transfers.delete(id);
  } catch (err) {
    t.error = err.message || String(err);
    room?.setLive({ xfer: null });
    toast(`“${sender.name}”’s song didn’t arrive: ${t.error}`);
  }
  refreshRoomScreens();
}

// Makes a room from this device's singers: the first singer's seat is the host, the others join after.
async function openRoom() {
  await loadUserSongs();
  room = new Room(onRoomUpdate);
  roomPlayed = 0;
  const [first, ...rest] = settings.players;
  const code = await room.enter(null, first.name);
  first.seat = room.main.id;
  for (const p of rest) p.seat = await room.addSeat(p.name);
  sendLibrary();
  await room.act('set', { song: settings.songId, mode: settings.mode, difficulty: settings.difficulty });
  history.replaceState(null, '', `#room=${code}`);
  window.__gv.room = code;
}

// A friend's phone, after opening the link: one seat, then its own screen until the host starts.
async function joinRoom(code) {
  await ensureEngine();
  await loadUserSongs();
  room = new Room(onRoomUpdate);
  roomPlayed = 0;
  try {
    const joined = await room.enter(code, settings.players[0].name);
    // Seats kept from earlier in this tab come back with the singers they belonged to (a host who reloaded).
    settings.players.forEach((p, i) => { if (room.seats[i]) p.seat = room.seats[i].id; else delete p.seat; });
    sendLibrary();
    history.replaceState(null, '', `#room=${joined}`);
    window.__gv.room = joined;
    // Don't drop into a song that has been playing for a while; wait for the next one.
    const r = room.view.room;
    if (r.startAt && room.serverNow() - r.startAt > 15000) roomPlayed = r.round;
    go(room.view.isHost ? 'singers' : 'guest');
  } catch (err) {
    toast(err.message || String(err));
    leaveRoom();
  }
}
const isGuest = () => !!room?.view && !room.view.isHost;

function leaveRoom() {
  room?.leave();
  room = null;
  settings.players.forEach((p) => delete p.seat);
  history.replaceState(null, '', location.pathname + location.search);
  go('title');
}

function onRoomUpdate(view) {
  if (!view) return;
  const r = view.room;
  // The host started a new song: play it (also from the results of the last one).
  if (r.round > roomPlayed && r.startAt && room.serverNow() - r.startAt < 15000 && !(game && !game.ended)) {
    roomPlayed = r.round;
    // Someone who arrived without the song sits this one out and gets it for the next.
    if (!haveSong(r.song)) return refreshRoomScreens();
    const members = r.roster.map((id) => view.members.find((m) => m.id === id)).filter(Boolean);
    startGame({ mode: 'room', song: r.song, turns: r.mode === 'turns', difficulty: r.difficulty, members, mine: view.mine, round: r.round, startAt: r.startAt, singer: roomSinger });
    return;
  }
  if (game && !game.ended && game.inRoom) {
    for (const p of game.players) {
      if (p.perf) continue;
      const live = view.members.find((m) => m.id === p.member)?.live;
      if (live?.round === game.round) p.remote = live;
    }
  }
  if (screen === 'results' && lastResults?.g.inRoom) printResults(lastResults.g, lastResults.results, false);
  if (!(game && !game.ended)) runTransfers(view);
  refreshRoomScreens();
}

// Room changes redraw only what changed on the screen showing, so names being typed and animations aren't reset.
function refreshRoomScreens() {
  if (screen === 'singers') {
    const list = channels();
    if (rackKey(list) !== renderSingers.keys) {
      const was = new Set(renderSingers.ids);
      renderSingers(new Set(list.map((s) => s.key).filter((k) => !was.has(k))));
    } else syncMode();
  } else if (screen === 'song') {
    const list = catalog();
    if (list.map((s) => `${s.id}:${s.pct ?? ''}:${s.by}:${s.len}`).join('|') !== renderSongList.key) renderSongList();
  } else if (screen === 'settings') syncSing();
  else if (screen === 'guest') renderGuest(true);
}

// ---------- Guest: a friend's phone shows the room and waits for the host ----------
function renderGuest(update) {
  const v = room?.view;
  if (!v) return;
  const host = v.members.find((m) => m.id === v.room.host);
  const hostName = host?.name || 'The host';
  $('h-guest').textContent = `${hostName}’s room`;
  const list = channels();
  const keys = list.map((s) => `${s.key}:${s.name}:${s.host}`).join('|');
  if (!update || keys !== renderGuest.keys) {
    renderGuest.keys = keys;
    const rows = list.map((s, i) => {
      const me = s.local != null;
      const name = me
        ? `<label class="namebox"><input class="namebox__name" type="text" value="${esc(s.name)}" maxlength="18" spellcheck="false" autocomplete="off" data-singer="${s.local}" aria-label="Your name"><span class="namebox__on">You</span></label>`
        : `<span class="namebox"><span class="namebox__name">${esc(s.name)}</span>${s.host ? '<span class="namebox__on">Host</span>' : ''}</span>`;
      return `<li class="ch" style="--c:${color(s.c)}"><span class="ch__no">${pad(i + 1)}</span><i class="ch__sw"></i>${name}
        <span class="meter meter--fill" data-meter="${esc(s.key)}" aria-hidden="true"></span></li>`;
    });
    for (let i = list.length + 1; i <= MAX_SINGERS; i++) rows.push(`<li class="ch ch--empty" aria-hidden="true"><span class="ch__no">${pad(i)}</span></li>`);
    if (!$('guest-row').contains(document.activeElement)) {
      $('guest-row').innerHTML = rows.join('');
      fitMeters();
    }
  }
  const picked = v.room.song && catalog().find((s) => s.id === v.room.song);
  const lcdKey = picked ? `${picked.id}:${picked.pct ?? ''}` : 'none';
  if (lcdKey !== renderGuest.lcd) {
    renderGuest.lcd = lcdKey;
    setLcd($('lcd-guest'), picked
      ? `<div class="lcd__in"><img class="lcd__cover" src="${picked.cover}" alt="">
        <div class="lcd__bar"><span><b>${esc(hostName)} picked</b></span><span>${picked.len || ''}</span></div>
        <div class="lcd__meta"><p class="lcd__title">${esc(picked.title)}</p><p class="lcd__by">${esc(picked.by)}</p></div></div>`
      : `<div class="lcd__in lcd__in--msg"><div class="lcd__bar"><span>Song</span></div><p class="lcd__title">${esc(hostName)} is picking a song</p></div>`, update ? 1 : 0);
  }
  $$('.g-ind').forEach((el) => { const on = !!picked && el.dataset.mode === v.room.mode; el.classList.toggle('is-on', on); el.querySelector('.led').classList.toggle('on', on); });
  // A song on its way to this phone.
  const t = picked && transfers.get(picked.id);
  $('guest-send').hidden = !t;
  if (t) {
    const pct = Math.round((t.p || 0) * 100);
    $('guest-send-l').textContent = `Getting ${picked.title}`;
    $('guest-xfer').innerHTML = `<span class="xfer__seg">${segs(pct)}</span>${pct}%`;
  }
  $('guest-wait').textContent = picked ? `Waiting for ${hostName} to press Sing` : `Waiting for ${hostName} to pick a song`;
}

// ---------- Game ----------
async function startGame(opts) {
  lastGameOpts = opts;
  stopMonitors();
  const song = opts.mode === 'room' ? SONGS.find((s) => s.id === opts.song) : selectedSong();
  go('game');
  $('pt-title').textContent = song.title;
  $('pt-time').textContent = '';
  $('ly-now').innerHTML = '';
  $('ly-next').textContent = '';
  call('Loading', null);
  $('chans').innerHTML = '';
  try {
    await ensureEngine();
    const [chart, inst, vocals] = await Promise.all([loadChart(song), engine.load(song.inst), engine.load(song.vocals)]);
    const difficulty = opts.difficulty || settings.difficulty;
    const inRoom = opts.mode === 'room';
    // Who sings: the room's people (this device's seats sing here), this device's singers, or one recorded
    // singer for the demo and tests.
    const local = settings.players.slice(0, settings.mode === 'together' ? MAX_MICS_HERE : MAX_SINGERS);
    const turnsMode = inRoom ? opts.turns : opts.mode === 'mic' ? settings.mode === 'turns' : !!opts.players;
    const cast = inRoom ? opts.members.map((m) => ({ name: m.name, member: m.id, c: m.color, here: opts.mine.includes(m.id) }))
      : opts.mode === 'mic' ? local.map((p, i) => ({ name: p.name, c: i, here: true }))
      : (opts.players || [opts.mode === 'demo' ? 'Demo singer' : opts.name || 'Test singer']).map((name, i) => ({ name, c: i, here: true }));
    const turns = turnsMode && cast.length > 1;
    const hereCount = cast.filter((c) => c.here).length;
    const sourceFor = async (i) => opts.mode === 'demo' ? { buffer: vocals, audible: true }
      : opts.mode === 'file' || opts.singer ? { buffer: await engine.load(opts.url || opts.singer), audible: opts.audible }
      : { stream: await getStream(i) };
    const lyricsOn = opts.lyrics ?? settings.lyrics;
    if (lyricsOn) ensureChecker(chart.language ?? null);
    // Taking turns shares one mic on this device; together, each singer here has their own.
    const inputs = [];
    for (let i = 0; i < (turns ? 1 : hereCount); i++) {
      const input = new VoiceInput(engine, await sourceFor(i), { latency: settings.latency / 1000 });
      await input.connect();
      input.enablePcm(lyricsOn);
      inputs.push({ input, players: [], shownAt: { disp: null, t: 0 } });
    }
    // Taking turns: lines go out in pairs, round the whole room.
    const owners = chart.lines.map((_, i) => (turns ? Math.floor(i / LINES_PER_TURN) % cast.length : null));
    let k = 0;
    const players = cast.map((c, i) => {
      const base = { id: `p${i}`, member: c.member ?? null, name: c.name, color: color(c.c), online: !c.here, shown: 0 };
      // Friends sing on their own devices: here they are a name and the score their device sends.
      if (!c.here) return { ...base, remote: {} };
      const group = inputs[turns ? 0 : k++];
      const owned = turns ? new Set(owners.flatMap((o, li) => (o === i ? [li] : []))) : null;
      const p = { ...base, input: group.input, frames: group.input.history, perf: new Performance(chart, difficulty, owned) };
      group.players.push(p);
      return p;
    });
    const scored = players.filter((p) => p.perf);
    const voices = inputs.map((g, i) => ({ id: `mic${i}`, color: g.players[0].color, frames: g.input.history }));
    if (!renderer) renderer = new StageRenderer($('hw'));
    renderer.resize();
    renderer.setSong(chart);
    renderChans(players, turns);
    const guide = opts.mode === 'demo' || opts.mode === 'file' || opts.singer ? 0 : GUIDE_LEVEL[opts.guide || settings.guide];
    game = { song, chart, players, scored, inputs, voices, turns, owners, opts, difficulty, lyricsOn, inRoom, round: opts.round, pendingChecks: 0, ui: '', counted: new Set(), sentAt: 0 };
    // A room's song starts at the same moment on every device; someone who arrives late joins mid-song.
    let offset = 0;
    if (inRoom) {
      for (;;) {
        const wait = opts.startAt - room.serverNow();
        if (wait <= 160) { offset = Math.max(0, -wait / 1000 - 0.15); break; }
        call(String(Math.ceil(wait / 1000)), null, true);
        await new Promise((r) => setTimeout(r, Math.min(250, wait - 150)));
        if (game?.ended) return;
      }
    }
    call('', null);
    const at = engine.play({ inst, vocals, guide, offset });
    inputs.forEach((g) => g.input.startWithSong(at));
    window.__gv.status = 'playing';
    requestAnimationFrame(tick);
  } catch (err) {
    console.error(err);
    call('', null);
    if (err?.name?.endsWith('Error') && /Allowed|NotFound|Overconstrained/.test(err.name)) micError(err);
    else toast(err.message || String(err));
    go(isGuest() ? 'guest' : 'settings');
    window.__gv.status = 'error';
    window.__gv.error = String(err?.message || err);
  }
}

// The layer over the highway: the countdown, loading, and whose turn it is.
function call(text, c, count = false) {
  const el = $('hw-call');
  el.textContent = text;
  el.style.setProperty('--cc', c || 'var(--face)');
  el.classList.toggle('is-count', count);
  el.classList.toggle('is-on', !!text);
}

function renderChans(players, turns) {
  const el = $('chans');
  el.style.setProperty('--n', players.length);
  el.classList.toggle('is-turns', turns);
  el.innerHTML = players.map((p) => `<li class="chan" style="--c:${p.color}">
    <div class="chan__id"><i class="led" aria-hidden="true"></i><i class="ch__sw"></i><span class="chan__name">${esc(p.name)}</span>${p.online ? `<span class="chan__on" title="On their phone">${G.on}<span class="sr">on their phone</span></span>` : ''}</div>
    <div class="chan__score"><span class="chan__num">0</span></div>
    <div class="chan__foot"><span class="chan__x" aria-label="Combo">${[1, 2, 3, 4].map((x) => `<span><i class="led"></i>×${x}</span>`).join('')}</span>
      <span class="chan__streak"><span class="silk">Streak</span><b>0</b></span></div></li>`).join('');
}

function nearestNote(perf, t) {
  let best = null, dist = 1.2;
  for (let i = Math.max(0, perf.cursor - 2); i < Math.min(perf.notes.length, perf.cursor + 3); i++) {
    const n = perf.notes[i];
    // Someone else's line in take-turns scores nothing, so the comet must not look like it's on it.
    if (n.skip) continue;
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
      const perf = shown.perf || g.players[0].perf;
      const n = f.midi == null ? null : perf.live.note || nearestNote(perf, f.t);
      f.disp = shownPitch(f.midi == null ? null : f.midi - tuning, n, center, g.shownAt, f.t);
    }
  }
  for (const p of game.scored) {
    for (const ev of p.perf.events.splice(0)) if (ev.type === 'line' && game.lyricsOn) scheduleLyricCheck(p, ev.line);
  }
  // One shared mic: the comet takes the colour of whoever's turn it is.
  if (game.turns) {
    const a = players[game.owners[lineAt(now)]];
    if (a.perf) game.voices[0].color = a.color;
  }
  renderer.draw(now, game.scored, game.voices);
  if (game.inRoom && performance.now() - game.sentAt > 900) {
    game.sentAt = performance.now();
    for (const p of game.scored) room?.setLive({ round: game.round, score: p.perf.score, mult: p.perf.multiplier, combo: p.perf.combo }, p.member);
  }
  updateLyrics(now);
  updateChans(now);
  countdown(now);
  if (now >= chart.duration + 0.3) endGame();
  else requestAnimationFrame(tick);
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
        p.perf.events.splice(0);
        (window.__gv.lyricLog ||= []).push({ player: p.name, line: line.text, heard: text, ratio });
      })
      .catch((err) => console.warn('lyric check failed', err))
      .finally(done);
  }, 500);
}

// The current line, its sung syllables lit; the next line under it. In a gap, the next line waits unlit.
function updateLyrics(now) {
  const lines = game.chart.lines;
  let i = lines.findIndex((l) => now < l.end + 0.3);
  const waiting = i >= 0 && lines[i].start - now > 2;
  const line = i >= 0 ? lines[i] : null;
  let k = -1;
  if (line && !waiting) k = line.notes.findLastIndex((n) => n.t <= now);
  const owner = game.turns && i >= 0 ? game.players[game.owners[i]] : null;
  const key = `${i}:${k}:${waiting}`;
  if (key === game.ui) return;
  game.ui = key;
  $('hw-lyr').style.setProperty('--lc', owner?.color || '#3ff0b4');
  $('ly-now').innerHTML = line ? line.notes.map((n, j) => (n.syl === '~' ? '' : `<span class="${j < k ? 'd' : j === k ? 'n' : ''}">${esc(n.syl)}</span>`) + (n.wordEnd ? ' ' : '')).join('') : '';
  $('ly-next').textContent = i >= 0 && lines[i + 1] ? lines[i + 1].text : '';
}

function updateChans(now) {
  const { chart, players } = game;
  // Taking turns: only the singer up now is lit, and their name is called before their first line.
  const live = game.turns ? game.owners[lineAt(now)] : -1;
  if (game.turns) {
    const lines = chart.lines, next = lines.findIndex((l) => l.start > now);
    const owner = next >= 0 ? game.owners[next] : null;
    const due = next >= 0 && lines[next].start - now < 2.6 && (next === 0 || game.owners[next - 1] !== owner);
    if (due && $('hw-call').dataset.k !== String(next)) {
      $('hw-call').dataset.k = next;
      call(`${players[owner].name}’s turn`, players[owner].color);
    } else if (!due && $('hw-call').dataset.k != null && !$('hw-call').classList.contains('is-count')) {
      delete $('hw-call').dataset.k;
      call('', null);
    }
  }
  $$('#chans .chan').forEach((el, si) => {
    const p = players[si];
    const on = live < 0 || si === live;
    el.classList.toggle('is-live', on);
    el.querySelector('.chan__id .led').classList.toggle('on', on);
    const { score = 0, mult = 1, combo = 0 } = p.perf ? { score: p.perf.score, mult: p.perf.multiplier, combo: p.perf.combo } : p.remote;
    p.shown += (score - p.shown) * 0.2;
    if (Math.abs(score - p.shown) < 1) p.shown = score;
    const v = fmt(Math.round(p.shown / 10) * 10), num = el.querySelector('.chan__num');
    if (num.textContent !== v) num.textContent = v;
    el.querySelectorAll('.chan__x > span').forEach((x, i) => { x.classList.toggle('is-on', i < mult); x.querySelector('.led').classList.toggle('on', i < mult); });
    const st = el.querySelector('.chan__streak b');
    if (st.textContent !== String(combo)) st.textContent = combo;
  });
  $('hw-prog').style.transform = `scaleX(${clamp(now / chart.duration, 0, 1)})`;
  const time = `${fmtTime(now)} / ${fmtTime(chart.duration)}`;
  if ($('pt-time').textContent !== time) $('pt-time').textContent = time;
}

// 3, 2, 1 on the beats before the first note.
function countdown(now) {
  const first = game.chart.lines[0]?.notes[0];
  if (!first) return;
  const spb = 60 / game.chart.bpm;
  const left = Math.ceil((first.t - now) / spb);
  // Taking turns calls the first singer instead.
  if (game.turns) return;
  if (left >= 1 && left <= 3 && !game.counted.has(left)) {
    game.counted.add(left);
    call(String(left), null, true);
    setTimeout(() => { if ($('hw-call').textContent === String(left)) call('', null); }, spb * 950);
  }
}

async function endGame() {
  if (!game || game.ended) return;
  game.ended = true;
  engine.stop();
  const g = game;
  if (g.pendingChecks > 0) {
    call('Checking the words', null);
    const t0 = performance.now();
    while (g.pendingChecks > 0 && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 150));
  }
  call('', null);
  g.inputs.forEach(({ input }) => input.disconnect());
  const results = g.scored.map((p) => ({ name: p.name, color: p.color, member: p.member, ...p.perf.finish() }));
  window.__gv.results = results.map(({ bestLine, worstLine, ...r }) => ({ ...r, bestLine: bestLine?.text, worstLine: worstLine?.text }));
  window.__gv.status = 'done';
  if (g.inRoom) for (const r of results) room?.send({ result: { round: g.round, score: r.score, accuracy: r.accuracy, title: r.title, stars: r.stars } }, r.member);
  else if (g.opts.mode === 'mic') for (const r of results) addToBoard(g.song.id, { name: r.name, score: r.score, acc: r.accuracy, difficulty: g.difficulty, at: Date.now() });
  go('results');
  printResults(g, results, true);
}

function stopGame() {
  if (!game) return;
  game.ended = true;
  engine.stop();
  game.inputs.forEach(({ input }) => input.disconnect());
  game = null;
}

// Best scores on this device, kept for when they get a place on screen again.
function addToBoard(songId, entry) {
  const list = [...store.get(`board:${songId}`, []), entry].sort((a, b) => b.score - a.score).slice(0, 8);
  store.set(`board:${songId}`, list);
}

// ---------- Pause ----------
async function pause() {
  if (!game || game.ended) return;
  await engine.pause();
  go('pause');
}
async function resume() {
  go('game');
  await engine.unpause();
}
function renderPause() {
  const g = game, now = engine.heardTime();
  setLcd($('lcd-pause'), `<div class="lcd__in"><img class="lcd__cover" src="${g.song.cover}" alt="">
    <div class="lcd__bar"><span><b>Paused</b></span><span>${fmtTime(now)} / ${fmtTime(g.chart.duration)}</span></div>
    <div class="lcd__meta"><p class="lcd__title">${esc(g.song.title)}</p>${segbar(now / g.chart.duration)}</div></div>`);
  $('delay').value = settings.latency;
  $('delay-out').textContent = `${settings.latency} ms`;
}

// ---------- Results: a printer feeds out a receipt ----------
let lastResults = null;
function countUp(el, to, delay, dur) {
  if (reduced.matches) { el.textContent = fmt(to); return; }
  el.textContent = '0';
  const t0 = performance.now() + delay;
  const f = (t) => { const p = clamp((t - t0) / dur, 0, 1); el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
// In a room, friends' scores arrive from their devices as they finish; the receipt reprints as they do.
function printResults(g, results, fresh) {
  lastResults = { g, results };
  const entries = [...results];
  if (g.inRoom) {
    for (const p of g.players) {
      if (p.perf) continue;
      const r = room?.view?.members.find((m) => m.id === p.member)?.result;
      // A friend's result comes from their device: take only the numbers and the title, as plain values.
      entries.push(r?.round === g.round
        ? { name: p.name, color: p.color, online: true, score: +r.score || 0, accuracy: +r.accuracy || 0, stars: +r.stars || 0, title: String(r.title) }
        : { name: p.name, color: p.color, online: true, score: +p.remote.score || 0, pending: true });
    }
  }
  const ranked = entries.sort((a, b) => b.score - a.score);
  const key = ranked.map((r) => `${r.name}:${r.score}:${!!r.pending}`).join('|');
  if (!fresh && key === printResults.key) return;
  printResults.key = key;
  $('rc-song').textContent = g.song.title;
  $('rc-meta').textContent = `${DIFFICULTY[g.difficulty].label} · ${g.turns ? 'Take turns' : 'Together'} · ${fmtTime(g.chart.duration)}`;
  const d = new Date();
  $('rc-date').textContent = `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  $('rc-count').textContent = `${ranked.length} singer${ranked.length === 1 ? '' : 's'}`;
  $('rc-rows').innerHTML = ranked.map((r, k) => `<li class="rc__row" style="--c:${r.color}">
    <span class="rc__rank">${k + 1}</span><span class="rc__name"><i class="rc__sw"></i>${esc(r.name)}${r.online ? `<span class="rc__on" title="On their phone">${G.on}<span class="sr">on their phone</span></span>` : ''}</span><span class="rc__score" data-to="${r.score}">${fmt(r.score)}</span>
    <span class="rc__title">${r.pending ? 'Still singing' : esc(r.title)}</span><span class="rc__stars" role="img" aria-label="${r.stars || 0} stars">${r.pending ? '' : starRow(r.stars)}</span></li>`).join('');
  const w = ranked[0];
  setLcd($('lcd-res'), `<div class="win" style="--c:${w.color}"><div class="lcd__bar"><span><b>1st</b>of ${ranked.length}</span><span>${esc(g.song.title)}</span></div>
    <p class="win__name">${esc(w.name)}</p><p class="win__score">${fmt(w.score)}</p>
    <div class="win__foot"><span>${w.pending ? 'Still singing' : esc(w.title)}</span><span class="rc__stars" role="img" aria-label="${w.stars || 0} stars">${w.pending ? '' : starRow(w.stars)}</span></div></div>`);
  if (!fresh) return;
  const paper = $('paper');
  paper.classList.remove('printing');
  void paper.offsetWidth;
  paper.classList.add('printing');
  $$('.rc__score').forEach((el, k) => countUp(el, +el.dataset.to, 260 + k * 90, 520));
  countUp(document.querySelector('.win__score'), w.score, 120, 640);
  // A friend's phone goes back to the room; only the host picks what's next.
  $('again-pick').hidden = isGuest();
  $('again').querySelector('.top').textContent = isGuest() ? 'Back to the room' : 'Sing again';
}

// ---------- Add your own song ----------
const STEPS = [
  { key: 'read', label: 'Reading the file' },
  { key: 'separate', label: 'Separating the voice from the music' },
  { key: 'lyrics', label: 'Listening for the words' },
  { key: 'notes', label: 'Finding the notes' },
  { key: 'save', label: 'Saving it on this device' },
];
// Raw pipeline stages → the step they belong to, with a note while that part runs. Model downloads also name the
// model, so the step can say it was downloaded once it is done.
const STAGE = {
  read: ['read'], download: ['separate', 'Downloading the voice model (only the first time)', 'voice'], separate: ['separate'],
  upload: ['separate', 'Uploading to our server'], server: ['separate', 'Our server is separating the voice and writing down the words'],
  pitch: ['lyrics', 'Tracking the melody'], 'pitch-model': ['lyrics', 'Downloading the melody model (only the first time)', 'melody'],
  'lyrics-model': ['lyrics', 'Downloading the speech model (only the first time)', 'speech'],
  words: ['lyrics', 'Writing down the words'], lyrics: ['lyrics'], notes: ['notes'], save: ['save'],
};
let importFile = null;
let importAbort = null;
let importReplace = null; // the upload a run remakes (its id), or null for a new song
let importWhere = '';
const isMedia = (f) => /^(audio|video)\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|mp4|m4v|mov|mkv|avi|wma|aif|aiff|3gp|flv|wmv)$/i.test(f.name);
const songName = (file) => file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

async function openImport(file = null, replace = null) {
  importReplace = replace;
  importFile = file;
  go('upload');
  const { gpuDevice } = await import('./import/importer.js');
  const gpu = await gpuDevice();
  importWhere = gpu ? 'The first time, this downloads about 700 MB'
    : SERVER ? 'Our server does the heavy part and deletes your file after'
      : 'This browser has no graphics chip access, so it takes a few minutes per minute of song';
  if (screen === 'upload') renderUpload();
}
function renderUpload() {
  const f = importFile, ok = f && isMedia(f), bay = $('bay');
  bay.dataset.state = !f ? 'empty' : ok ? 'file' : 'error';
  $('bay-t').textContent = f ? f.name : 'Drop an audio or video file';
  $('bay-s').textContent = !f ? importWhere : ok ? `${(f.size / 1e6).toFixed(1)} MB` : 'Not an audio or video file';
  $('bay-led').classList.toggle('on', !!f);
  $('bay-led').classList.toggle('led--mint', !f || ok);
  $('choose').querySelector('.top').textContent = f ? 'Choose another' : 'Choose file';
  $('make').disabled = !ok;
}
function takeFile(f) {
  if (!f) return;
  if (screen === 'upload') { importFile = f; renderUpload(); } else openImport(f, null);
}

// Each step's LED: done (with any model it downloaded), running (with its progress), or waiting.
function renderSteps(name, current, progress, note, got, error) {
  const at = STEPS.findIndex((s) => s.key === current);
  const all = Math.floor(((at + (progress ?? 0)) / STEPS.length) * 100);
  setLcd($('lcd-up'), `<div class="lcd__in lcd__in--msg"><div class="lcd__bar"><span><b>${error ? 'That didn’t work' : importReplace ? 'Remaking it' : 'Making it singable'}</b></span><span>${error ? '' : `${all}%`}</span></div>
    <p class="lcd__title${error ? ' lcd__err' : ''}">${esc(error || name)}</p>${error ? '' : segbar(all / 100)}</div>`);
  $('up-steps').innerHTML = STEPS.map((s, i) => {
    const st = i < at ? 'done' : i === at ? (error ? 'wait' : 'run') : 'wait';
    const pct = Math.round((progress ?? 0) * 100);
    const right = st === 'done' ? G.done : st === 'run' && progress != null ? `<span class="xfer"><span class="xfer__seg">${segs(pct)}</span>${pct}%</span>` : '';
    const models = got.get(s.key) || [];
    const sub = st === 'run' && note ? note : models.length ? `Downloaded the ${models.join(' and ')} model${models.length > 1 ? 's' : ''}` : '';
    return `<li class="ust" data-s="${st}"><i class="led${st === 'done' ? ' led--mint on' : st === 'run' ? ' on blink' : ''}" aria-hidden="true"></i><span class="ust__l">${s.label}</span><span class="ust__r">${right}</span>${sub ? `<span class="ust__sub">${esc(sub)}</span>` : ''}</li>`;
  }).join('');
}

async function runImport() {
  const file = importFile;
  // A remake from the stored original has no file name; it keeps the song's title.
  if (!file || (file.name && !isMedia(file)) || importAbort) return;
  go('upload-progress');
  const name = file.name ? songName(file.name) : SONGS.find((s) => s.id === importReplace)?.title || 'Your song';
  importAbort = new AbortController();
  const signal = importAbort.signal;
  let last = 0;
  // A model counts as downloaded when its download ran (a stored one reports done at once) and the next part began.
  const got = new Map();
  let fetching = null, cur = 'read';
  const stage = (s, p) => {
    const [step, note, model] = STAGE[s] || [s];
    cur = step;
    if (fetching && s !== fetching.name) {
      got.set(fetching.step, [...(got.get(fetching.step) || []), fetching.model]);
      fetching = null;
    }
    const downloading = p > 0 && p < 1;
    if (model && downloading) fetching = { name: s, step, model };
    const now = performance.now();
    if (downloading && now - last < 120) return;
    last = now;
    if (screen === 'upload-progress') renderSteps(name, step, p, model && !downloading ? null : note, got);
  };
  renderSteps(name, 'read', 0, null, got);
  const t0 = performance.now();
  try {
    const { importSong } = await import('./import/importer.js');
    const rec = await importSong(file, { lyrics: $('lyrics').value, server: SERVER, signal, stage });
    renderSteps(name, 'save', null, null, got);
    // A remake keeps the old song's place: same id (so its scores stay) and first upload time.
    const old = importReplace ? SONGS.findIndex((s) => s.id === importReplace) : -1;
    if (importReplace) {
      rec.id = rec.chart.id = importReplace;
      rec.createdAt = (await getUserSong(importReplace))?.createdAt ?? rec.createdAt;
    }
    await saveUserSong(rec);
    const song = userSong(rec);
    if (old >= 0) {
      releaseSong(SONGS[old]);
      SONGS[old] = song;
    } else SONGS.push(song);
    sendLibrary();
    settings.songId = song.id;
    saveSettings();
    if (room?.view?.isHost) room.act('set', { song: song.id }).catch((err) => toast(err.message));
    $('lyrics').value = '';
    importFile = null;
    window.__gv.imported = { id: rec.id, lines: rec.chart.lines.length, secs: Math.round((performance.now() - t0) / 1000), where: rec.where, language: rec.chart.language };
    importAbort = null;
    go('song');
  } catch (err) {
    importAbort = null;
    if (err?.name === 'AbortError') return;
    console.error(err);
    renderSteps(name, cur, null, null, got, err.message || String(err));
    window.__gv.importError = String(err?.message || err);
  }
}

// Uploads made by an older version: remake from the stored original, pick the file again (uploads from before files
// were kept), or play it as it is. A friend's song can only be remade by the friend.
async function askRemake(song) {
  const rec = await getUserSong(song.id);
  const friend = rec.where === 'friend';
  const line = rec.source ? 'The new version finds the notes and words better'
    : friend ? `Ask ${rec.from || 'your friend'} to remake it and share it again`
      : 'Choose the same file again to remake it';
  setLcd($('lcd-outdated'), `<div class="lcd__in"><img class="lcd__cover" src="${song.cover}" alt="">
    <div class="lcd__bar"><span><b>Made with an older version</b></span></div>
    <div class="lcd__meta"><p class="lcd__title">${esc(song.title)}</p><p class="lcd__by">${esc(line)}</p></div></div>`);
  const remake = $('outdated-remake');
  remake.hidden = friend && !rec.source;
  remake.querySelector('.top').textContent = rec.source ? 'Remake it' : 'Choose the file';
  remake.onclick = () => {
    if (rec.source) { importFile = rec.source; importReplace = song.id; runImport(); } else openImport(null, song.id);
  };
  $('outdated-play').onclick = () => { outdatedOk = true; toSettings(); };
  go('outdated');
}

// ---------- Wiring ----------
encSong = makeEncoder($('enc-song'), { count: () => catalog().length, get: () => selIndex(), set: selectSong, onEnter: toSettings });
initSlide($('mode'), (v) => { setMode(v); connectMonitors(); });
initSlide($('sw-diff'), (v) => { settings.difficulty = DIFFS[+v]; saveSettings(); if (room?.view?.isHost) room.act('set', { difficulty: settings.difficulty }).catch(() => {}); });
// Speakers: the mic reopens with echo cancellation at the next song, and the original vocal starts off, since out
// loud it sings your notes into your mic (turn it back up if you like).
initSlide($('sw-out'), (v) => {
  settings.speakers = v === '1';
  if (settings.speakers) { settings.guide = 'off'; setRadio($('sw-vocal'), 0); }
  saveSettings();
});
initSlide($('sw-vocal'), (v) => { settings.guide = GUIDES[+v]; saveSettings(); });

async function sing() {
  // With friends online, the room starts the song on every device at once.
  if (room?.view && remoteHere()) {
    if (!room.view.isHost) return;
    return room.act('start', { song: selectedId(), mode: roomMode(), difficulty: settings.difficulty }).catch((err) => toast(err.message));
  }
  startGame({ mode: 'mic' });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  if (t.id === 'latch-words') { settings.lyrics = !settings.lyrics; saveSettings(); if (settings.lyrics) ensureChecker(); syncWords(); }
  else if (t.id === 'upload-btn') openImport();
  else if (t.id === 'choose') $('file').click();
  else if (t.id === 'make') runImport();
  else if (t.id === 'sing') sing();
  else if (t.id === 'pause-btn') pause();
  else if (t.id === 'resume') resume();
  else if (t.id === 'restart') { const opts = game?.opts; engine.unpause().then(() => { stopGame(); startGame(opts || { mode: 'mic' }); }); }
  else if (t.id === 'quit') { engine.unpause().then(() => { stopGame(); go(isGuest() ? 'guest' : 'song'); }); }
  else if (t.id === 'again') { isGuest() ? go('guest') : go('settings'); }
  else if (t.id === 'again-pick') go('song');
  else if (t.id === 'invite-btn') copyInvite(t);
  else if (t.dataset.pick != null) { const list = catalog(), k = list.findIndex((s) => s.id === t.dataset.pick); selectSong(k, Math.sign(k - selIndex(list))); encSong.render(); }
  else if (t.dataset.add != null) addSinger();
  else if (t.dataset.remove != null) removeSinger(+t.dataset.remove);
  else if (t.dataset.back != null) back();
  else if (t.dataset.go === 'singers' && screen === 'title') { ensureEngine(); roomInLink() && !room ? joinRoom(roomInLink()) : go('singers'); }
  else if (t.dataset.go === 'settings') toSettings();
  else if (t.dataset.go) go(t.dataset.go);
});
$('file').addEventListener('change', (e) => { takeFile(e.target.files[0]); e.target.value = ''; });
$('bay').addEventListener('click', (e) => { if (!e.target.closest('button')) $('file').click(); });
$('delay').addEventListener('input', (e) => {
  settings.latency = +e.target.value;
  $('delay-out').textContent = `${settings.latency} ms`;
  saveSettings();
  game?.inputs.forEach(({ input }) => (input.latency = settings.latency / 1000));
});

// Names: typed straight into the channel. A cleared name keeps the last one when you leave the box.
document.addEventListener('focusin', (e) => { if (e.target.matches('.namebox input')) e.target.dataset.prev = e.target.value; });
document.addEventListener('input', (e) => {
  const inp = e.target;
  if (inp.dataset.singer == null || !inp.value.trim()) return;
  const p = settings.players[+inp.dataset.singer];
  p.name = inp.value.trim();
  saveSettings();
  if (p.seat) room?.send({ name: p.name }, p.seat);
  inp.closest('.ch').querySelector('[data-remove]')?.setAttribute('aria-label', `Remove ${p.name}`);
});
document.addEventListener('focusout', (e) => {
  const inp = e.target;
  if (!inp.matches?.('.namebox input') || inp.value.trim()) return;
  inp.value = inp.dataset.prev || settings.players[+inp.dataset.singer]?.name || 'Singer';
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.matches?.('.namebox input')) {
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape') { t.value = t.dataset.prev; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); }
    return;
  }
  if (t.matches?.('textarea')) return;
  if (screen === 'game' && (e.key === 'Escape' || e.key === 'p')) { e.preventDefault(); pause(); return; }
  const key = t.closest?.('.key');
  if (key && (e.key === ' ' || e.key === 'Enter')) key.classList.add('is-down');
  if (e.key === 'Escape') { back(); return; }
  if (e.key === 'Enter' && !t.closest?.('button, a, [role=slider]')) {
    const k = device.querySelector('.screen.is-on .key--sun:not(:disabled)');
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
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; device.classList.remove('is-drop'); if (dropHere()) takeFile(e.dataTransfer.files[0]); });

// ---------- Boot ----------
// Built-in songs' credits and lengths come from their charts.
for (const s of SONGS.filter((x) => !x.user)) {
  loadChart(s).then((c) => { credit.set(s.id, c.credit || ''); credit.set(`${s.id}:len`, fmtTime(c.duration)); if (screen === 'song') renderSongList(); }).catch(() => {});
}
loadUserSongs();
go('title');
// Test hook: ?singer=<audio url> makes room games sing that recording instead of the mic.
const roomSinger = params.get('singer') || undefined;
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
    if (SONGS.some((s) => s.id === params.get('autoplay'))) settings.songId = params.get('autoplay');
    if (opts.lyrics) ensureChecker();
    window.__gv.start = () => startGame(opts);
    if (params.get('wait') !== '1') ensureEngine().then(() => startGame(opts));
  });
}
