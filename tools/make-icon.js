/*
 * make-icon.js — regenerate icon128.png, the Chrome Web Store store icon.
 *
 * The store rejects an item whose package carries no icon, and the icon has to
 * be 128x128. Rather than ship a binary nobody can edit, the mark is drawn
 * here from geometry: a rounded tile in the same blue the in-page button uses,
 * with a white download arrow on top.
 *
 *   node tools/make-icon.js
 *
 * No dependencies: the PNG is assembled byte by byte with zlib. Output is
 * deterministic — same file every run, so the icon can be diffed in git.
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- geometry, in 128-space ---------- */

const TILE = { x0: 16, y0: 16, x1: 112, y1: 112, r: 24 };
const BLUE = [0x1d, 0x9b, 0xf0];
const WHITE = [0xff, 0xff, 0xff];

// the arrow: a stem and a head, both flat white
const STEM = { x0: 57, y0: 40, x1: 71, y1: 66 };
const HEAD = [[46, 64], [82, 64], [64, 90]];

const inRoundedRect = (x, y, r) => {
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
  const cx = Math.min(Math.max(x, r.x0 + r.r), r.x1 - r.r);
  const cy = Math.min(Math.max(y, r.y0 + r.r), r.y1 - r.r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r.r * r.r;
};

const inTriangle = (x, y, [a, b, c]) => {
  const s = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

// what colour is this point? the arrow wins, it sits on the tile
function sample(x, y) {
  const arrow =
    (x >= STEM.x0 && x <= STEM.x1 && y >= STEM.y0 && y <= STEM.y1) ||
    inTriangle(x, y, HEAD);
  if (arrow) return { r: WHITE[0], g: WHITE[1], b: WHITE[2], a: 255 };
  if (inRoundedRect(x, y, TILE)) return { r: BLUE[0], g: BLUE[1], b: BLUE[2], a: 255 };
  return { r: 0, g: 0, b: 0, a: 0 };
}

/* ---------- raster ---------- */

const W = 128;
const SS = 3; // supersampling factor, for smooth edges
const px = Buffer.alloc(W * W * 4);

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    let aSum = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        aSum += c.a;
        rSum += c.r * c.a; gSum += c.g * c.a; bSum += c.b * c.a;
      }
    }
    const n = SS * SS;
    const a = aSum / n;
    const o = (y * W + x) * 4;
    if (a > 0) {
      px[o] = Math.round(rSum / aSum);
      px[o + 1] = Math.round(gSum / aSum);
      px[o + 2] = Math.round(bSum / aSum);
    }
    px[o + 3] = Math.round(a);
  }
}

/* ---------- PNG ---------- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'icon128.png');
fs.writeFileSync(out, png);
console.log(`${out} — ${W}x${W}, ${png.length} bytes`);
