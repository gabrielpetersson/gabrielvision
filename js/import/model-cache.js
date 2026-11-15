// Downloads a model file once and keeps it in Cache Storage, reporting download progress.

export async function cachedModel(url, onProgress = () => {}) {
  const cache = await caches.open('gv-models').catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    onProgress(1);
    return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the model (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  onProgress(1);
  return bytes;
}
