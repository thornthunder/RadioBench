// Draws RadioBench's icons: a tuning dial on a dark tile, as PNG, without any image library.
// Usage: node make-icons.mjs  (from anywhere; writes next to this script's parent folder)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** PNG encoding of an RGBA buffer. */
function png(width, height, rgba) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32BE(crc(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crcBytes]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by a shape, from its signed distance (negative inside), anti-aliased. */
const cover = (distance) => Math.max(0, Math.min(1, 0.5 - distance));

/** The icon at a given size: a rounded dark tile, an amber dial ring with a pointer, a green lamp. */
function draw(size, { tile = true } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const ringRadius = s * 0.33;
  const ringWidth = s * 0.075;
  const pointerAngle = -Math.PI * 0.75; // towards the upper left, like a dial at "10 o'clock"
  const lampX = s * 0.76;
  const lampY = s * 0.76;
  const lampRadius = s * 0.07;
  const tileRadius = s * 0.2;
  const inset = tile ? s * 0.04 : -s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Rounded tile.
      const qx = Math.abs(px - cx) - (cx - inset - tileRadius);
      const qy = Math.abs(py - cy) - (cy - inset - tileRadius);
      const tileDistance =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - tileRadius;
      let r = 0x23,
        g = 0x25,
        b = 0x28,
        a = tile ? cover(tileDistance) : 0;
      const blend = (cr, cg, cb, coverage) => {
        if (coverage <= 0) return;
        r = r * (1 - coverage) + cr * coverage;
        g = g * (1 - coverage) + cg * coverage;
        b = b * (1 - coverage) + cb * coverage;
        a = Math.max(a, coverage);
      };
      // Dial ring.
      const d = Math.hypot(px - cx, py - cy);
      blend(0xff, 0xb8, 0x1c, cover(Math.abs(d - ringRadius) - ringWidth / 2));
      // Pointer: a line from the centre out to the ring.
      const ux = Math.cos(pointerAngle);
      const uy = Math.sin(pointerAngle);
      const along = (px - cx) * ux + (py - cy) * uy;
      const across = Math.abs((px - cx) * -uy + (py - cy) * ux);
      if (along > -ringWidth && along < ringRadius) {
        blend(0xee, 0xf0, 0xf4, cover(across - ringWidth * 0.45));
      }
      blend(0xee, 0xf0, 0xf4, cover(d - ringWidth * 0.7));
      // Lamp.
      blend(0x35, 0xc4, 0x6a, cover(Math.hypot(px - lampX, py - lampY) - lampRadius));
      const at = (y * s + x) * 4;
      rgba[at] = Math.round(r);
      rgba[at + 1] = Math.round(g);
      rgba[at + 2] = Math.round(b);
      rgba[at + 3] = Math.round(a * 255);
    }
  }
  return png(s, s, rgba);
}

mkdirSync(`${root}build`, { recursive: true });
mkdirSync(`${root}static`, { recursive: true });
writeFileSync(`${root}build/icon.png`, draw(512));
writeFileSync(`${root}static/icon.png`, draw(256));
writeFileSync(`${root}static/tray.png`, draw(32));
writeFileSync(`${root}static/tray@2x.png`, draw(64));
console.log('icons written to build/ and static/');
