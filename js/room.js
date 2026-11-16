// @ts-check
// Client for the room service (rooms/worker.js): make or join a room, then poll it about once a second.
// A room member is one singer. A device holds one seat per singer singing on it, in the same order as its singers:
// the main seat (made or joined first) and one more for each extra singer. Every seat polls, which says "I'm here"
// (plus its name, live score or final result) and brings back the room.
// Songs pass between friends through /api/song: one person who has the song uploads it, the others fetch it.

const BASE = location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://gabrielvision-rooms.deadblock.workers.dev';
const API = `${BASE}/api/room`;
const POLL_MS = 1000;
/** @param {string} code */
const SEATS = (code) => `gv:seats:${code}`;

/** @param {string} code */
export const inviteLink = (code) => `${location.origin}${location.pathname}#room=${code}`;
export const roomInLink = () => new URLSearchParams(location.hash.slice(1)).get('room')?.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6) || '';

class RoomError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** @param {Record<string, unknown>} body */
async function call(body) {
  const res = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `The room service did not answer (${res.status}).` }));
  if (!res.ok) throw new RoomError(data.error || `Room error ${res.status}`, res.status);
  return data;
}

/** @param {Seat} s */
const keys = ({ code, id, token }) => ({ code, id, token });
/** @param {string} code @param {{ id: string, token: string }} res @returns {Seat} */
const newSeat = (code, { id, token }) => ({ code, id, token, pending: {}, live: {} });

export class Room {
  /** @param {(view: RoomView) => void} onUpdate every fresh view of the room
   * @param {(message: string) => void} onClosed the room closed or this device was dropped from it */
  constructor(onUpdate, onClosed) {
    this.onUpdate = onUpdate;
    this.onClosed = onClosed;
    /** @type {RoomView | null} */
    this.view = null;
    this.offset = 0; // server clock minus this clock, in ms
    /** @type {number | null} */
    this.bestRtt = null;
    /** @type {Seat[]} main seat first */
    this.seats = [];
    this.closed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined;
  }

  get main() {
    return this.seats[0];
  }

  /** Joins the room in the link, or makes a new one, with the main seat. Seats kept from earlier in this tab come
   * back (a reload). @param {string | null} code @param {string} name */
  async enter(code, name) {
    /** @type {Seat[]} */
    const kept = code ? JSON.parse(sessionStorage.getItem(SEATS(code)) || '[]').map((/** @type {Seat} */ s) => newSeat(s.code, s)) : [];
    if (kept.length) {
      this.seats = kept;
      try {
        await this.syncSeat(this.main, { name });
        this.loop();
        return this.main.code;
      } catch (err) {
        if (!(err instanceof RoomError && err.status === 403)) throw err;
      }
    }
    const t0 = Date.now();
    const res = code ? await call({ action: 'join', code, name }) : await call({ action: 'create', name });
    this.offset = res.now - (t0 + Date.now()) / 2;
    this.seats = [newSeat(code || res.code, res)];
    this.keep();
    await this.syncSeat(this.main, {});
    this.loop();
    return this.main.code;
  }

  /** Another singer on this device; returns their member id. @param {string} name */
  async addSeat(name) {
    const seat = newSeat(this.main.code, await call({ action: 'join', code: this.main.code, name }));
    this.seats.push(seat);
    this.keep();
    await this.syncSeat(seat, {});
    return seat.id;
  }

  /** @param {string} id */
  removeSeat(id) {
    const seat = this.seat(id);
    if (seat === this.main) throw new Error('The main seat leaves with the room');
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

  /** @param {string} id */
  seat(id) {
    const seat = this.seats.find((s) => s.id === id);
    if (!seat) throw new Error(`No seat ${id} on this device`);
    return seat;
  }

  /** Fields that ride on the seat's next poll (name, library, result). @param {Record<string, unknown>} fields @param {string} id */
  send(fields, id = this.main.id) {
    Object.assign(this.seat(id).pending, fields);
  }

  /** Live state goes whole with each poll; this merges a change into it. @param {Live} fields @param {string} id */
  setLive(fields, id = this.main.id) {
    const seat = this.seat(id);
    Object.assign(seat.live, fields);
    seat.pending.live = { ...seat.live };
  }

  /** @param {string} song */
  songUrl(song) {
    return `${BASE}/api/song?${new URLSearchParams({ ...keys(this.main), song })}`;
  }

  /** @param {string} song @param {Blob} blob @param {(p: number) => void} onProgress @returns {Promise<void>} */
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

  /** A song sent a moment ago can take up to a minute to reach the server's other regions, so a miss is retried.
   * @param {string} song @param {number} size @param {(p: number) => void} onProgress */
  async download(song, size, onProgress) {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error('Left the room');
      const res = await fetch(this.songUrl(song));
      if (res.status === 404 && attempt < 40) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`Getting the song failed (${res.status}).`);
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onProgress(Math.min(1, got / size));
      }
      return new Blob(parts);
    }
  }

  /** One seat's poll. The main seat's reply is the room everyone on this device sees.
   * @param {Seat} seat @param {Record<string, unknown>} extra */
  async syncSeat(seat, extra) {
    const t0 = Date.now();
    const sent = seat.pending;
    seat.pending = {};
    /** @type {any} */
    let view;
    try {
      view = await call({ action: 'sync', ...keys(seat), ...sent, ...extra });
    } catch (err) {
      // A failed poll keeps what it was carrying (a final result, a new name) for the next one; newer fields win.
      seat.pending = { ...sent, ...seat.pending };
      throw err;
    }
    if (seat !== this.main) return;
    const t1 = Date.now();
    // Keep the clock offset from the quickest round trips (least uncertainty).
    const rtt = t1 - t0;
    if (this.bestRtt == null || rtt <= this.bestRtt * 1.5) {
      this.bestRtt = Math.min(this.bestRtt ?? rtt, rtt);
      this.offset = view.now - (t0 + t1) / 2;
    }
    this.apply(view);
  }

  /** @param {Omit<RoomView, 'mine' | 'isHost'>} view */
  apply(view) {
    const mine = this.seats.map((s) => s.id);
    this.view = { ...view, mine, isHost: mine.includes(view.room.host) };
    if (!this.closed) this.onUpdate(this.view);
  }

  /** set (song, mode, difficulty) and start: host only, from whichever seat here holds the host role.
   * @param {'set' | 'start'} action @param {Record<string, unknown>} fields */
  async act(action, fields) {
    const host = this.seats.find((s) => s.id === this.view?.room.host) || this.main;
    this.apply(await call({ action, ...keys(host), ...fields }));
  }

  loop() {
    clearTimeout(this.timer);
    const tick = async () => {
      if (this.closed) return;
      const results = await Promise.allSettled(this.seats.map((s) => this.syncSeat(s, {})));
      if (this.closed) return;
      // The main seat refused (the room closed, or it was dropped after a long time away): this device is out.
      const main = results[0];
      if (main.status === 'rejected' && main.reason instanceof RoomError && (main.reason.status === 403 || main.reason.status === 404)) {
        this.leave();
        this.onClosed(main.reason.message);
        return;
      }
      this.timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    this.timer = setTimeout(tick, POLL_MS);
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.main) return;
    sessionStorage.removeItem(SEATS(this.main.code));
    for (const seat of this.seats) call({ action: 'leave', ...keys(seat) }).catch(() => {});
  }
}
