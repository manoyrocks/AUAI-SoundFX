/**
 * Generate the app icon set as real PNGs, with no image dependencies.
 *
 * Run: node apps/web/scripts/gen-icons.mjs
 *
 * Writing a minimal PNG encoder (IHDR/IDAT/IEND + CRC32, deflate via Node's
 * built-in zlib) is a few dozen lines and avoids adding an image-processing
 * dependency to a project that otherwise has none. The icons are committed,
 * so this script only runs when the mark changes.
 *
 * The mark is drawn from the same visual language as the generative field:
 * concentric rings on the near-black ground, in the accent colour. Content
 * stays inside the central 60% so the maskable variant survives aggressive
 * platform cropping (Android's safe zone is a circle of 80% diameter).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// App palette, kept in sync with style.css.
const BG = [0x05, 0x06, 0x0a];
const ACCENT = [0x7c, 0xf0, 0xc8];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixel data (Uint8Array, w*h*4) as a PNG buffer. */
function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy
      ? rgba.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4)
      : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Composite a colour over the accumulating pixel with straight alpha. */
function blend(px, i, rgb, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  px[i] = Math.round(px[i] * (1 - a) + rgb[0] * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + rgb[1] * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + rgb[2] * a);
  px[i + 3] = 255;
}

/**
 * Draw the mark.
 * @param size    square edge in px
 * @param inset   0..1 fraction of the canvas the artwork occupies
 */
function drawIcon(size, inset) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = BG[0];
    px[i * 4 + 1] = BG[1];
    px[i * 4 + 2] = BG[2];
    px[i * 4 + 3] = 255;
  }

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const R = (size / 2) * inset;

  // Three rings plus a solid core, echoing the field visual's orbiting bands.
  const rings = [
    { r: 0.96, w: 0.055, a: 0.28 },
    { r: 0.7, w: 0.07, a: 0.55 },
    { r: 0.44, w: 0.085, a: 0.85 },
  ];

  // Supersample 3x3 per pixel so the curves are smooth without a rasteriser.
  const S = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      let weighted = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px_ = x + (sx + 0.5) / S - 0.5;
          const py_ = y + (sy + 0.5) / S - 0.5;
          const d = Math.hypot(px_ - cx, py_ - cy) / R;
          for (const ring of rings) {
            if (Math.abs(d - ring.r) <= ring.w / 2) {
              cov++;
              weighted += ring.a;
            }
          }
          if (d <= 0.17) {
            cov++;
            weighted += 1;
          }
        }
      }
      if (cov > 0) blend(px, (y * size + x) * 4, ACCENT, weighted / (S * S));
    }
  }
  return px;
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  // Standard icons: artwork near the edges.
  { name: "icon-192.png", size: 192, inset: 0.88 },
  { name: "icon-512.png", size: 512, inset: 0.88 },
  { name: "apple-touch-icon.png", size: 180, inset: 0.82 },
  { name: "favicon-32.png", size: 32, inset: 0.94 },
  // Maskable: artwork pulled well inside the platform safe zone.
  { name: "icon-maskable-512.png", size: 512, inset: 0.6 },
];

for (const t of targets) {
  const png = encodePng(drawIcon(t.size, t.inset), t.size, t.size);
  writeFileSync(join(OUT_DIR, t.name), png);
  console.log(`${t.name.padEnd(26)} ${String(png.length).padStart(7)} bytes`);
}
console.log(`\nWrote ${targets.length} icons to ${OUT_DIR}`);
