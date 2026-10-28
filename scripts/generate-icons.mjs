import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sizes = [16, 32, 48, 128];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function insideRoundedSquare(x, y, size, radius) {
  const cx = x < radius ? radius : x > size - radius ? size - radius : x;
  const cy = y < radius ? radius : y > size - radius ? size - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const scale = 4;
  const high = size * scale;
  const rgba = Buffer.alloc(size * size * 4);
  const radius = high * 0.2;
  const stroke = high * 0.105;
  const left = [high * 0.29, high * 0.76, high * 0.5, high * 0.23];
  const right = [high * 0.71, high * 0.76, high * 0.5, high * 0.23];
  const bar = [high * 0.38, high * 0.57, high * 0.62, high * 0.57];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let green = 0;
      let white = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = x * scale + sx + 0.5;
          const py = y * scale + sy + 0.5;
          if (insideRoundedSquare(px, py, high, radius)) green++;
          if (
            distanceToSegment(px, py, ...left) <= stroke / 2 ||
            distanceToSegment(px, py, ...right) <= stroke / 2 ||
            distanceToSegment(px, py, ...bar) <= stroke / 2
          ) white++;
        }
      }
      const samples = scale * scale;
      const bgAlpha = green / samples;
      const fgAlpha = Math.min(bgAlpha, white / samples);
      const offset = (y * size + x) * 4;
      const base = [5, 150, 105];
      const alpha = bgAlpha;
      rgba[offset] = Math.round(base[0] * (1 - fgAlpha) + 255 * fgAlpha);
      rgba[offset + 1] = Math.round(base[1] * (1 - fgAlpha) + 255 * fgAlpha);
      rgba[offset + 2] = Math.round(base[2] * (1 - fgAlpha) + 255 * fgAlpha);
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const extensionDir = path.join(root, "packages/extension/public/icons");
const storeDir = path.join(root, "store-assets");
mkdirSync(extensionDir, { recursive: true });
mkdirSync(storeDir, { recursive: true });
for (const size of sizes) {
  const png = render(size);
  writeFileSync(path.join(extensionDir, `icon-${size}.png`), png);
  if (size === 128) writeFileSync(path.join(storeDir, "icon-128.png"), png);
}
