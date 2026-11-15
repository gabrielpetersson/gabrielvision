// Title, artist and cover art from an MP3's ID3v2 tag. Other formats fall back to the file name.

const text = (bytes) => {
  const enc = bytes[0];
  const body = bytes.subarray(1);
  const label = enc === 1 || enc === 2 ? (enc === 1 ? 'utf-16' : 'utf-16be') : enc === 3 ? 'utf-8' : 'latin1';
  return new TextDecoder(label).decode(body).replace(/\0+$/g, '').replace(/^\uFEFF/, '').trim();
};

export async function readTags(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const version = head[3];
  const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const size = syncsafe(head, 6);
  const tag = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  const out = {};
  let o = 0;
  while (o + 10 <= tag.length) {
    const id = String.fromCharCode(...tag.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = version === 4 ? syncsafe(tag, o + 4) : (tag[o + 4] << 24) | (tag[o + 5] << 16) | (tag[o + 6] << 8) | tag[o + 7];
    const body = tag.subarray(o + 10, o + 10 + len);
    if (id === 'TIT2') out.title = text(body);
    else if (id === 'TPE1') out.artist = text(body);
    else if (id === 'APIC' && !out.cover) {
      const enc = body[0];
      let p = 1;
      const mimeEnd = body.indexOf(0, p);
      const mime = new TextDecoder('latin1').decode(body.subarray(p, mimeEnd)) || 'image/jpeg';
      p = mimeEnd + 2; // skip the picture type byte
      const wide = enc === 1 || enc === 2;
      while (p < body.length && (wide ? body[p] || body[p + 1] : body[p])) p += wide ? 2 : 1;
      p += wide ? 2 : 1;
      out.cover = new Blob([body.slice(p)], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` });
    }
    o += 10 + len;
  }
  return out;
}
