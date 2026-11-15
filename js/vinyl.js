// The start screen's turntable: the record spins; grab it and scratch (it follows the drag, then spins back up).
// Drawn only while the start screen is showing.

export function startVinyl(platter, canvas, isShowing) {
  const g = canvas.getContext('2d');
  let S = 0, angle = 0, speed = 0.9, drag = null, last = performance.now();
  const size = () => {
    const r = canvas.getBoundingClientRect();
    S = r.width;
    canvas.width = canvas.height = Math.round(S * Math.min(2, devicePixelRatio));
    g.setTransform(canvas.width / S, 0, 0, canvas.width / S, 0, 0);
  };
  const ang = (e) => {
    const r = platter.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  platter.addEventListener('pointerdown', (e) => {
    drag = { a: ang(e), t: performance.now() };
    platter.setPointerCapture(e.pointerId);
  });
  platter.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const a = ang(e), now = performance.now();
    let d = a - drag.a;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    angle += d;
    speed = ((d / Math.max(1, now - drag.t)) * 1000) / (2 * Math.PI) * 0.6;
    drag = { a, t: now };
  });
  platter.addEventListener('pointerup', () => (drag = null));
  platter.addEventListener('pointercancel', () => (drag = null));
  addEventListener('resize', size);

  function draw() {
    if (!S) size();
    const R = S / 2;
    g.clearRect(0, 0, S, S);
    g.save();
    g.translate(R, R);
    g.rotate(angle);
    g.fillStyle = '#141414';
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
    for (let r = R * 0.38; r < R * 0.97; r += 2.2) {
      g.strokeStyle = `rgba(255,255,255,${0.04 + 0.03 * Math.sin(r * 0.21)})`;
      g.lineWidth = 1;
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R * 0.97, -0.5, 0.1); g.fill();
    g.fillStyle = '#ff5d3b';
    g.beginPath(); g.arc(0, 0, R * 0.34, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#141414';
    g.textAlign = 'center';
    g.font = `400 ${R * 0.08}px "Archivo Black"`;
    g.fillText('GABRIEL', 0, -R * 0.13);
    g.font = `800 ${R * 0.045}px Archivo`;
    g.fillText('SINGING CONTEST', 0, -R * 0.06);
    g.fillText('SIDE A · 33⅓', 0, R * 0.19);
    g.fillStyle = '#e9e9e2';
    g.beginPath(); g.arc(0, 0, R * 0.03, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  (function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (isShowing()) {
      if (!drag) {
        speed += (0.9 - speed) * Math.min(1, dt * 2.2);
        angle += speed * dt * 2 * Math.PI * 0.55;
      }
      draw();
    }
    requestAnimationFrame(tick);
  })(last);
  document.fonts.ready.then(() => { size(); draw(); });
}
