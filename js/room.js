// Client for the room service (rooms/worker.js): make or join a room, then poll it about once a second.
// Each poll says "I'm here" (plus my name, live score or final result) and brings back the room.

const API = location.hostname === 'localhost' ? 'http://localhost:8787/api/room' : 'https://gabrielvision-rooms.deadblock.workers.dev/api/room';
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

  // Extra fields ride on the next poll (name, live score, result); host actions go out at once.
  send(fields) {
    Object.assign(this.pending, fields);
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

  async host(action, fields) {
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
