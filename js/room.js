// Client for the room service (rooms/worker.js): make or join a room, then poll it about once a second.
// Each poll says "I'm here" (plus my name, library, live state or final result) and brings back the room.
// Songs pass between friends through /api/song: one person who has the song uploads it, the others fetch it.

const BASE = location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://gabrielvision-rooms.deadblock.workers.dev';
const API = `${BASE}/api/room`;
const POLL_MS = 1000;
const SEAT = (code) => `gv:seat:${code}`;

export const inviteLink = (code) => `${location.origin}${location.pathname}#room=${code}`;
export const roomInLink = () => new URLSearchParams(location.hash.slice(1)).get('room')?.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6) || '';

async function call(body) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `The room service did not answer (${res.status}).` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `Room error ${res.status}`), { status: res.status });
  return data;
}

export class Room {
  // onUpdate(view) gets every fresh room view: { room, members, me, isHost }.
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.view = null;
    this.offset = 0; // server clock minus this clock, in ms
    this.pending = {};
    // What others see of me besides my name: live score in a song, songs I have sent, a transfer in progress.
    this.live = {};
  }

  // Joins the room in the link, or makes a new one. A seat kept from earlier in this tab is reused.
  async enter(code, name) {
    const kept = code && JSON.parse(sessionStorage.getItem(SEAT(code)) || 'null');
    if (kept) {
      this.seat = kept;
      try {
        await this.sync({ name });
        this.loop();
        return this.seat.code;
      } catch (err) {
        if (err.status !== 403) throw err;
      }
    }
    const t0 = Date.now();
    const res = code ? await call({ action: 'join', code, name }) : await call({ action: 'create', name });
    this.offset = res.now - (t0 + Date.now()) / 2;
    this.seat = { code: code || res.code, id: res.id, token: res.token };
    sessionStorage.setItem(SEAT(this.seat.code), JSON.stringify(this.seat));
    await this.sync({});
    this.loop();
    return this.seat.code;
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  // Extra fields ride on the next poll (name, library, result); room actions go out at once.
  send(fields) {
    Object.assign(this.pending, fields);
  }

  // Live state is sent whole; this merges a change into it.
  setLive(fields) {
    Object.assign(this.live, fields);
    this.pending.live = { ...this.live };
  }

  songUrl(song) {
    return `${BASE}/api/song?${new URLSearchParams({ ...this.seat, song })}`;
  }

  upload(song, blob, onProgress) {
    const xhr = new XMLHttpRequest();
    return new Promise((resolve, reject) => {
      xhr.open('POST', this.songUrl(song));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || `Sending failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Sending the song failed. Check the connection.'));
      xhr.send(blob);
    });
  }

  // A song sent a moment ago can take up to a minute to reach the server's other regions, so a miss is retried.
  async download(song, size, onProgress) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.songUrl(song));
      if (res.status === 404 && attempt < 40) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok) throw new Error(`Getting the song failed (${res.status}).`);
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (size) onProgress(Math.min(1, got / size));
      }
      return new Blob(parts);
    }
  }

  async sync(extra) {
    const t0 = Date.now();
    const body = { action: 'sync', ...this.seat, ...this.pending, ...extra };
    this.pending = {};
    const view = await call(body);
    const t1 = Date.now();
    // Keep the clock offset from the quickest round trips (least uncertainty).
    const rtt = t1 - t0;
    if (this.bestRtt == null || rtt <= this.bestRtt * 1.5) {
      this.bestRtt = Math.min(this.bestRtt ?? rtt, rtt);
      this.offset = view.now - (t0 + t1) / 2;
    }
    this.apply(view);
    return view;
  }

  apply(view) {
    this.view = { ...view, me: this.seat.id, isHost: view.room.host === this.seat.id };
    this.onUpdate?.(this.view);
  }

  // set (song, or the host's mode) and start (host only); the reply is the fresh room.
  async act(action, fields) {
    const view = await call({ action, ...this.seat, ...fields });
    this.apply(view);
  }

  loop() {
    clearTimeout(this.timer);
    const tick = async () => {
      if (this.closed) return;
      try {
        await this.sync({});
        this.error = null;
      } catch (err) {
        this.error = err;
        this.onUpdate?.(this.view);
      }
      this.timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    this.timer = setTimeout(tick, POLL_MS);
  }

  leave() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.seat) {
      sessionStorage.removeItem(SEAT(this.seat.code));
      call({ action: 'leave', ...this.seat }).catch(() => {});
    }
  }
}
