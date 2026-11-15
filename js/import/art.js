// Artwork for uploaded songs: a generated cover when the file has none, and a blurred stage backdrop.

const PAIRS = [
  ['#FF5CD6', '#FFB547'], ['#6EF3FF', '#A98BFF'], ['#B8FF6B', '#3DDC97'], ['#FF8A5B', '#FFD66B'],
  ['#7AA2FF', '#FF77B7'], ['#FFB547', '#FF4D6D'], ['#5FE6FF', '#FF4D6D'], ['#C38BFF', '#6EF3FF'],
];

export function accentsFor(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return PAIRS[h % PAIRS.length];
}

function wrap(g, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function makeCover(title, artist, [a, b]) {
  await Promise.all([document.fonts.load('800 60px Unbounded'), document.fonts.load('600 20px Inter')]).catch(() => {});
  const S = 640, c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#07080f';
  g.fillRect(0, 0, S, S);
  for (const [x, y, r, col] of [[S * 0.15, S * 0.1, S * 0.9, a], [S * 0.95, S * 0.85, S * 0.8, b]]) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, col + 'cc');
    grad.addColorStop(1, col + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  // Sound rings around a stage light.
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  for (let r = 60; r < S; r += 38) {
    g.lineWidth = r % 76 ? 1 : 2;
    g.beginPath();
    g.arc(S * 0.78, S * 0.24, r, 0, Math.PI * 2);
    g.stroke();
  }
  // Equalizer bars along the bottom.
  let seed = title.length * 97;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 28; i++) {
    const h = 20 + rnd() * 90;
    g.fillStyle = `rgba(255,255,255,${0.12 + rnd() * 0.2})`;
    g.fillRect(36 + i * 21, S - 40 - h, 12, h);
  }
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.font = '600 20px Inter, system-ui, sans-serif';
  g.fillText('YOUR SONG', 40, 64);
  g.fillStyle = '#fff';
  let size = 64;
  let lines;
  do {
    g.font = `800 ${size}px Unbounded, 'Arial Black', sans-serif`;
    lines = wrap(g, title.toUpperCase(), S - 80);
    size -= 4;
  } while ((lines.length > 4 || lines.some((l) => g.measureText(l).width > S - 80)) && size > 24);
  const lh = size * 1.12;
  const top = S * 0.5 - (lines.length * lh) / 2 + size * 0.6;
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 24;
  lines.forEach((l, i) => g.fillText(l, 40, top + i * lh));
  if (artist) {
    g.font = '600 24px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillText(artist, 40, top + lines.length * lh + 6);
  }
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
}

export async function makeStage(cover, [a, b]) {
  const img = await createImageBitmap(cover);
  const W = 1600, H = 900, c = new OffscreenCanvas(W, H), g = c.getContext('2d');
  const s = Math.max(W / img.width, H / img.height) * 1.15;
  g.filter = 'blur(36px) saturate(1.3)';
  g.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
  g.filter = 'none';
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, a + '55');
  grad.addColorStop(1, b + '55');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
}
