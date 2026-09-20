// Generates PNG icons from scratch (no deps) using Node's built-in zlib.
// Draws the Reversi mark: green felt, a faint 4x4 grid, and the opening four
// discs in the middle — white on the leading diagonal, black on the other,
// each carrying the same non-colour marker the board uses. Mirrors
// icons/icon.svg; if you change one, change both. Run:
//   npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Straight from css/styles.css: --felt, --felt-2, --disc-black, --disc-white.
// The glow is a lighter felt rather than a separate hue, because the board is
// meant to look like cloth catching light, not like a UI surface.
const FELT = [0x17, 0x55, 0x40];
const GLOW = [0x2A, 0x7E, 0x5A];
const BLACK = [0x14, 0x16, 0x1D];
const WHITE = [0xF2, 0xF0, 0xE7];

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Coverage in [0,1] for a distance crossing an edge, anti-aliased over ±aa. */
function edgeCoverage(dist, edge, aa) { return 1 - smoothstep(edge - aa, edge + aa, dist); }

/** Blend `src` over the running colour by `cov`, in place on a 3-tuple. */
function over(rgb, src, cov) {
  if (cov <= 0) return;
  rgb[0] = rgb[0] * (1 - cov) + src[0] * cov;
  rgb[1] = rgb[1] * (1 - cov) + src[1] * cov;
  rgb[2] = rgb[2] * (1 - cov) + src[2] * cov;
}

function drawIcon(size, scale = 1) {
  const u = size / 512;              // design units -> pixels
  const aa = u * 1.4;
  const cx = size / 2, cy = size / 2;
  const buf = Buffer.alloc(size * size * 4);

  // Everything is laid out on the 512 design grid, then scaled about the
  // centre (scale < 1 shrinks the content into a maskable safe area while the
  // felt stays full bleed).
  const at = (v) => cx + (v - 256) * u * scale;
  const lines = [96, 176, 256, 336, 416];
  const halfLine = 1.5 * u * scale;

  // Middle four cells of the 4x4. Same arrangement as a real opening.
  const discs = [
    { x: 216, y: 216, fill: WHITE, mark: 'bar' },
    { x: 296, y: 296, fill: WHITE, mark: 'bar' },
    { x: 296, y: 216, fill: BLACK, mark: 'ring' },
    { x: 216, y: 296, fill: BLACK, mark: 'ring' },
  ];
  const discR = 30 * u * scale;
  const ringR = 10 * u * scale;
  const ringW = 1.5 * u * scale;     // half of the SVG's stroke-width: 3
  const barHalfW = 11.4 * u * scale;
  const barHalfH = 3.6 * u * scale;

  const gridMin = at(96), gridMax = at(416);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Felt: a soft glow from the top edge fading into the cloth.
      const glow = 1 - smoothstep(0, size * 0.75, Math.hypot(px - cx, py) * 0.9);
      const rgb = [
        FELT[0] * (1 - glow) + GLOW[0] * glow,
        FELT[1] * (1 - glow) + GLOW[1] * glow,
        FELT[2] * (1 - glow) + GLOW[2] * glow,
      ];

      // Faint grid, clipped to the board square. Dark lines, matching
      // --felt-line, rather than the light ones a card table would have.
      let grid = 0;
      if (px >= gridMin - halfLine && px <= gridMax + halfLine &&
          py >= gridMin - halfLine && py <= gridMax + halfLine) {
        for (const v of lines) {
          grid = Math.max(grid, edgeCoverage(Math.abs(px - at(v)), halfLine, aa));
          grid = Math.max(grid, edgeCoverage(Math.abs(py - at(v)), halfLine, aa));
        }
      }
      over(rgb, [0, 0, 0], grid * 0.34);

      // Discs, then their markers on top. Drawn one at a time rather than as
      // a max() over all four, because they are not all the same colour.
      for (const d of discs) {
        const dx = px - at(d.x), dy = py - at(d.y);
        const dist = Math.hypot(dx, dy);
        if (dist > discR + aa) continue;

        over(rgb, d.fill, edgeCoverage(dist, discR, aa));

        if (d.mark === 'ring') {
          over(rgb, [255, 255, 255], edgeCoverage(Math.abs(dist - ringR), ringW, aa) * 0.34);
        } else {
          // A rounded rect is overkill at this size; a hard-edged bar with
          // anti-aliased sides is indistinguishable and much simpler.
          const inBar = edgeCoverage(Math.abs(dx), barHalfW, aa)
            * edgeCoverage(Math.abs(dy), barHalfH, aa);
          over(rgb, [0, 0, 0], inBar * 0.36);
        }
      }

      const i = (y * size + x) * 4;
      buf[i] = Math.round(rgb[0]);
      buf[i + 1] = Math.round(rgb[1]);
      buf[i + 2] = Math.round(rgb[2]);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // rest 0 (compression, filter, interlace)

  // Filter each scanline with filter type 0.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const targets = [
  { name: 'icon-192.png', size: 192, scale: 1 },
  { name: 'icon-512.png', size: 512, scale: 1 },
  { name: 'icon-maskable.png', size: 512, scale: 0.7 }, // shrink for safe area
];
for (const t of targets) {
  const png = encodePNG(drawIcon(t.size, t.scale), t.size);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
