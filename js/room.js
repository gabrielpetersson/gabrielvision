// Client for the room service (rooms/worker.js): make or join a room, then poll it about once a second.
// A room member is one singer. A device holds one seat per singer singing on it: the main seat (made or joined
// first; the host's when this device made the room) and one more for each extra local singer. Every seat polls,
// which says "I'm here" (plus its name, live score or final result) and brings back the room.
// Songs pass between friends through /api/song: one person who has the song uploads it, the others fetch it.

const BASE = location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://gabrielvision-rooms.deadblock.workers.dev';
const API = `${BASE}/api/room`;
const POLL_MS = 1000;
const SEATS = (code) => `gv:seats:${code}`;

export const inviteLink = (code) => `${location.origin}${location.pathname}#room=${code}`;
export const roomInLink = () => new URLSearchParams(location.hash.slice(1)).get('room')?.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6) || '';

async function call(body) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `The room service did not answer (${res.status}).` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `Room error ${res.status}`), { status: res.status });
  return data;
}

const keys = ({ code, id, token }) => ({ code, id, token });

export class Room {
  // onUpdate(view) gets every fresh room view: { room, members, me, mine, isHost }.
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.view = null;
    this.offset = 0; // server clock minus this clock, in ms
    this.seats = []; // [{ code, id, token, pending, live }], main seat first
  }

  get main() {
    return this.seats[0];
  }

  // Joins the room in the link, or makes a new one, with the main seat. Seats kept from earlier in this tab return.
  async enter(code, name) {
    const kept = code ? JSON.parse(sessionStorage.getItem(SEATS(code)) || '[]') : [];
    if (kept.length) {
      this.seats = kept.map((s) => ({ ...s, pending: {}, live: {} }));
      try {
        await this.syncSeat(this.main, { name });
        this.loop();
        return this.main.code;
      } catch (err) {
        if (err.status !== 403) throw err;
        this.seats = [];
      }
    }
    const t0 = Date.now();
    const res = code ? await call({ action: 'join', code, name }) : await call({ action: 'create', name });
    this.offset = res.now - (t0 + Date.now()) / 2;
    this.seats = [{ code: code || res.code, id: res.id, token: res.token, pending: {}, live: {} }];
    this.keep();
    await this.syncSeat(this.main, {});
    this.loop();
    return this.main.code;
  }

  // Another singer on this device; returns their member id.
  async addSeat(name) {
    const res = await call({ action: 'join', code: this.main.code, name });
    const seat = { code: this.main.code, id: res.id, token: res.token, pending: {}, live: {} };
    this.seats.push(seat);
    this.keep();
    await this.syncSeat(seat, {});
    return seat.id;
  }

  removeSeat(id) {
    const seat = this.seats.find((s) => s.id === id);
    if (!seat || seat === this.main) return;
    this.seats = this.seats.filter((s) => s !== seat);
    this.keep();
    call({ action: 'leave', ...keys(seat) }).catch(() => {});
  }

  keep() {
    sessionStorage.setItem(SEATS(this.main.code), JSON.stringify(this.seats.map(keys)));
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  seat(id) {
    return this.seats.find((s) => s.id === id) || this.main;
  }

  // Extra fields ride on the seat's next poll (name, library, result); room actions go out at once.
  send(fields, id) {
    Object.assign(this.seat(id).pending, fields);
  }

  // Live state is sent whole; this merges a change into it.
  setLive(fields, id) {
    const seat = this.seat(id);
    Object.assign(seat.live, fields);
    seat.pending.live = { ...seat.live };
  }

  get live() {
    return this.main.live;
  }

  songUrl(song) {
    return `${BASE}/api/song?${new URLSearchParams({ ...keys(this.main), song })}`;
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

  // One seat's poll. The main seat's reply is the room everyone on this device sees.
  async syncSeat(seat, extra) {
    const t0 = Date.now();
    const body = { action: 'sync', ...keys(seat), ...seat.pending, ...extra };
    seat.pending = {};
    const view = await call(body);
    if (seat !== this.main) return view;
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
    const mine = this.seats.map((s) => s.id);
    this.view = { ...view, me: this.main.id, mine, isHost: view.room.host === this.main.id };
    this.onUpdate?.(this.view);
  }

  // set (song, or the host's mode) and start (host only), from the main seat; the reply is the fresh room.
  async act(action, fields) {
    const view = await call({ action, ...keys(this.main), ...fields });
    this.apply(view);
  }

  loop() {
    clearTimeout(this.timer);
    const tick = async () => {
      if (this.closed) return;
      const results = await Promise.allSettled(this.seats.map((s) => this.syncSeat(s, {})));
      const failed = results.find((r) => r.status === 'rejected');
      this.error = failed ? failed.reason : null;
      if (failed) this.onUpdate?.(this.view);
      this.timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    this.timer = setTimeout(tick, POLL_MS);
  }

  leave() {
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.main) return;
    sessionStorage.removeItem(SEATS(this.main.code));
    for (const seat of this.seats) call({ action: 'leave', ...keys(seat) }).catch(() => {});
  }
}
