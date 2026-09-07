const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'icons');

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function blend(pixels, index, color, opacity) {
  const alpha = clamp(opacity);
  const inverse = 1 - alpha;
  pixels[index] = Math.round(pixels[index] * inverse + color[0] * alpha);
  pixels[index + 1] = Math.round(pixels[index + 1] * inverse + color[1] * alpha);
  pixels[index + 2] = Math.round(pixels[index + 2] * inverse + color[2] * alpha);
}

function drawCircle(pixels, size, cx, cy, radius, color) {
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp(radius - distance + 0.5);
      if (coverage) blend(pixels, (y * size + x) * 4, color, coverage);
    }
  }
}

function drawGhost(pixels, size) {
  const ghost = [83, 183, 166];
  const dark = [12, 21, 24];
  const blush = [243, 160, 108];

  // A simple mascot stays recognizable after Android's mask crops the icon.
  drawCircle(pixels, size, size * 0.74, size * 0.25, size * 0.13, blush);
  drawCircle(pixels, size, size * 0.5, size * 0.43, size * 0.275, ghost);

  const left = Math.round(size * 0.225);
  const right = Math.round(size * 0.775);
  const top = Math.round(size * 0.43);
  const bottom = Math.round(size * 0.73);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      blend(pixels, (y * size + x) * 4, ghost, 1);
    }
  }

  drawCircle(pixels, size, size * 0.3, size * 0.72, size * 0.075, ghost);
  drawCircle(pixels, size, size * 0.5, size * 0.72, size * 0.075, ghost);
  drawCircle(pixels, size, size * 0.7, size * 0.72, size * 0.075, ghost);
  drawCircle(pixels, size, size * 0.4, size * 0.47, size * 0.045, dark);
  drawCircle(pixels, size, size * 0.6, size * 0.47, size * 0.045, dark);
  drawCircle(pixels, size, size * 0.5, size * 0.59, size * 0.025, dark);
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function pngBuffer(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const shade = 0.15 + (y / size) * 0.35 + (x / size) * 0.08;
      const index = (y * size + x) * 4;
      pixels[index] = Math.round(10 + shade * 20);
      pixels[index + 1] = Math.round(19 + shade * 34);
      pixels[index + 2] = Math.round(22 + shade * 35);
      pixels[index + 3] = 255;
    }
  }
  drawGhost(pixels, size);

  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    rows[rowStart] = 0;
    pixels.copy(rows, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(OUTPUT_DIR, `ghostchat-${size}.png`), pngBuffer(size));
}
