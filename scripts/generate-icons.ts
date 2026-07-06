import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

// All web icons derive from the app-icon master (the real Spotify mark: black
// tile, green circle, black waves) so web and iOS share one identity. The
// header logo + favicon use a circle-only cutout (transparent corners) so the
// mark fills the frame; tile-backed contexts (apple-touch-icon, PWA icon, the
// CoverImage fallback) keep the full square art.
const root = join(import.meta.dir, "..");
const masterPath = join(root, "mobile/assets/images/icon.png");
const master = readFileSync(masterPath);

const MASTER_SIZE = 1024;
// The green circle spans x 80→943 on the 1024 tile (measured), centered.
const CIRCLE_DIAMETER = 864;
const CIRCLE_OFFSET = Math.round((MASTER_SIZE - CIRCLE_DIAMETER) / 2);

// Cut the green circle out of the tile: crop to its bounding square, resize,
// then punch the corners transparent with a circular alpha mask. Two sharp
// passes — a single pipeline composites after resize, so the full-size mask
// wouldn't fit the resized image.
async function circleOnly(size: number): Promise<Buffer> {
  const cropped = await sharp(master)
    .extract({ left: CIRCLE_OFFSET, top: CIRCLE_OFFSET, width: CIRCLE_DIAMETER, height: CIRCLE_DIAMETER })
    .resize(size, size)
    .png()
    .toBuffer();
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(cropped)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function tile(size: number): Promise<Buffer> {
  return sharp(master).resize(size, size).png().toBuffer();
}

writeFileSync(join(root, "public/logo.png"), await circleOnly(256));
writeFileSync(join(root, "public/apple-icon.png"), await tile(180));
writeFileSync(join(root, "public/icon-512.png"), await tile(512));

// ICO: PNG entries in a minimal ICO container (Windows Vista+ format).
function buildIco(images: Array<{ size: number; data: Buffer }>) {
  const count = images.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries: Buffer[] = [];

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

writeFileSync(
  join(root, "public/favicon.ico"),
  buildIco([
    { size: 16, data: await circleOnly(16) },
    { size: 32, data: await circleOnly(32) },
    { size: 48, data: await circleOnly(48) },
  ]),
);

console.log("Generated public/logo.png, public/favicon.ico, public/apple-icon.png, public/icon-512.png");
