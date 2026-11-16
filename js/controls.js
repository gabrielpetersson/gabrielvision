// @ts-check
// The device's controls: slide switches, the detented song knob, the inset displays and LED bars. They know nothing
// about the game; main.js tells them what to show.

/** @param {string} id */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} sel @param {ParentNode} root @returns {HTMLElement[]} */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)].map((e) => /** @type {HTMLElement} */ (e));
/** @param {number} v @param {number} a @param {number} b */
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** @param {number} n */
export const pad = (n) => String(n).padStart(2, '0');
/** @param {unknown} s */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** @param {number} n */
export const fmt = (n) => Math.round(n).toLocaleString('en-US');
/** @param {number} s */
export const fmtTime = (s) => `${Math.floor(Math.max(0, s) / 60)}:${pad(Math.floor(Math.max(0, s) % 60))}`;
export const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/** Ten LED segments for a percentage. @param {number} pct */
export const segs = (pct) => { const lit = Math.floor(pct / 10); return Array.from({ length: 10 }, (_, i) => `<i class="${i < lit ? 'on' : i === lit ? 'now' : ''}"></i>`).join(''); };
/** @param {number} frac */
export const segbar = (frac) => `<div class="segbar">${Array.from({ length: 20 }, (_, i) => `<i class="${i < frac * 20 ? 'on' : ''}"></i>`).join('')}</div>`;
/** @param {number} n stars, in halves */
export const starRow = (n) => Array.from({ length: 5 }, (_, i) => {
  const fill = n >= i + 1 ? 'currentColor' : n > i ? 'url(#half)' : 'none';
  return `<svg viewBox="0 0 24 24"><use href="#star" fill="${fill}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}).join('');

/** Fills an inset display; dir slides the new content in from that side. @param {HTMLElement} el @param {string} html */
export function setLcd(el, html, dir = 0) {
  const scr = /** @type {HTMLElement} */ (el.querySelector('.lcd__screen'));
  scr.innerHTML = html;
  if (dir && !reduced.matches) scr.firstElementChild?.animate([{ opacity: 0, transform: `translateX(${dir * 10}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

/** A slide switch: radios under a track you can click or drag. */
export class Slide {
  /** @param {HTMLElement} root @param {(value: string) => void} onChange */
  constructor(root, onChange) {
    this.root = root;
    this.radios = $$('input[type=radio]', root).map((r) => /** @type {HTMLInputElement} */ (r));
    const track = /** @type {HTMLElement} */ (root.querySelector('.slide__track'));
    /** @param {number} x */
    const pick = (x) => {
      const r = track.getBoundingClientRect();
      const i = clamp(Math.floor(((x - r.left) / r.width) * this.radios.length), 0, this.radios.length - 1);
      if (this.radios[i].disabled || this.radios[i].checked) return;
      this.radios[i].checked = true;
      this.radios[i].dispatchEvent(new Event('change', { bubbles: true }));
    };
    this.radios.forEach((r) => r.addEventListener('change', () => { this.sync(); onChange(r.value); }));
    track.addEventListener('pointerdown', (e) => {
      if (this.radios.every((r) => r.disabled)) return;
      track.setPointerCapture(e.pointerId);
      root.classList.add('is-drag');
      pick(e.clientX);
      this.radios.find((r) => r.checked)?.focus({ preventScroll: true });
    });
    track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) pick(e.clientX); });
    const end = () => root.classList.remove('is-drag');
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    this.sync();
  }

  sync() {
    this.root.style.setProperty('--i', String(Math.max(0, this.radios.findIndex((r) => r.checked))));
  }

  /** Shows a value without firing onChange. @param {string} value */
  set(value) {
    this.radios.forEach((r) => { r.checked = r.value === value; });
    this.sync();
  }
}

/** The rotary knob with a detent per song. The detents share at most 300 degrees, so a long list still fits; with
 * many songs only every few ticks is numbered.
 * @param {HTMLElement} el @param {{ count: () => number, get: () => number, set: (i: number, dir: number) => void, onEnter: () => void }} o */
export function makeEncoder(el, { count, get, set, onEnter }) {
  const stepOf = () => Math.min(30, 300 / Math.max(1, count() - 1));
  const knob = /** @type {HTMLElement} */ (el.querySelector('.enc__knob')), seat = /** @type {HTMLElement} */ (el.querySelector('.enc__seat')), ticks = /** @type {SVGElement} */ (el.querySelector('.enc__ticks'));
  let acc = 0, last = 0, drag = false, wheel = 0, wheelAt = 0;
  const angle = (/** @type {PointerEvent} */ e) => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
  const render = (tension = 0) => {
    const n = count(), i = get();
    knob.style.setProperty('--a', `${(i - (n - 1) / 2) * stepOf() + tension}deg`);
    el.setAttribute('aria-valuemax', String(n));
    el.setAttribute('aria-valuenow', String(i + 1));
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
  const go = (/** @type {number} */ i) => {
    const cur = get(), next = clamp(i, 0, count() - 1);
    if (next === cur) return false;
    set(next, Math.sign(next - cur));
    if (!reduced.matches) { seat.classList.remove('seat'); void seat.offsetWidth; seat.classList.add('seat'); }
    return true;
  };
  const step = (/** @type {number} */ d) => { go(get() + d); render(); };
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
