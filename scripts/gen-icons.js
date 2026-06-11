// Generates PNG icons from scratch (no deps) using Node's built-in zlib.
// Draws the Fishbowl mark: deep-water background, an aqua bowl rim with a wavy
// water line inside and two rising bubbles, all anti-aliased. Run:
//   node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x06, 0x13, 0x18];
const AQUA = [0x38, 0xD6, 0xF0];

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// coverage in [0,1] for a value crossing an edge at `edge`, aa width ~1px
function edgeCoverage(dist, edge, aa) { return 1 - smoothstep(edge - aa, edge + aa, dist); }

function drawIcon(size, scale = 1) {
  // scale shrinks the content for maskable safe-area.
  const cx = size / 2;
  const cy = size * 0.512;                 // bowl sits a touch below centre
  const ringR = size * 0.234 * scale;      // bowl rim radius
  const ringW = size * 0.035 * scale;      // rim half-thickness
  const innerR = ringR - ringW * 0.6;      // water is clipped to just inside the rim
  const aa = size / 512 * 1.4;
  const buf = Buffer.alloc(size * size * 4);

  // Two rising bubbles, offset up-and-right of the bowl centre.
  const b1 = { x: cx + size * 0.086 * scale, y: cy - size * 0.059 * scale, r: size * 0.031 * scale };
  const b2 = { x: cx + size * 0.145 * scale, y: cy - size * 0.129 * scale, r: size * 0.018 * scale };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.hypot(px - cx, py - cy);
      let r = BG[0], g = BG[1], b = BG[2];

      // Water: inside the inner circle and below a gently waving surface line.
      const waveY = cy + Math.sin((px / size) * Math.PI * 3) * size * 0.012 * scale;
      const insideWater = edgeCoverage(d, innerR, aa);
      const belowSurface = smoothstep(waveY - aa, waveY + aa, py);
      const waterCov = insideWater * belowSurface * 0.22;
      r = r * (1 - waterCov) + AQUA[0] * waterCov;
      g = g * (1 - waterCov) + AQUA[1] * waterCov;
      b = b * (1 - waterCov) + AQUA[2] * waterCov;

      // Bowl rim: covered where |d - ringR| < ringW.
      const ringCov = edgeCoverage(Math.abs(d - ringR), ringW, aa);
      // Bubbles.
      const bub1 = edgeCoverage(Math.hypot(px - b1.x, py - b1.y), b1.r, aa);
      const bub2 = edgeCoverage(Math.hypot(px - b2.x, py - b2.y), b2.r, aa) * 0.8;
      const solid = Math.max(ringCov, bub1, bub2);
      r = r * (1 - solid) + AQUA[0] * solid;
      g = g * (1 - solid) + AQUA[1] * solid;
      b = b * (1 - solid) + AQUA[2] * solid;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
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
  ihdr[9] = 6;   // color type RGBA
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

const outDir = path.join(__dirname, '..', 'icons');
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
