import { NextResponse } from "next/server";
import { parseFile } from "music-metadata";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeJoin(baseDir: string, pathSegments: string[]): string | null {
  const targetPath = resolve(baseDir, ...pathSegments);
  const normalizedBase = resolve(baseDir) + sep;
  if (!targetPath.startsWith(normalizedBase)) return null;
  return targetPath;
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string[] }> }) {
  const baseDir = join(process.cwd(), "public", "uploads", "audio");
  const { file } = await params;
  const segments = Array.isArray(file) ? file : [file];
  const audioPath = safeJoin(baseDir, segments);
  if (!audioPath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    // Ensure file exists
    const s = await stat(audioPath);
    if (!s.isFile()) throw new Error("Not a file");

    const meta = await parseFile(audioPath, { duration: false, skipCovers: false });
    const picture = meta.common.picture?.[0];
    if (picture?.data?.length) {
      const headers = new Headers();
      headers.set("Content-Type", picture.format || "image/jpeg");
      headers.set("Cache-Control", "public, max-age=604800, immutable");
      const arrayBuffer = new ArrayBuffer(picture.data.byteLength);
      new Uint8Array(arrayBuffer).set(picture.data);
      return new Response(arrayBuffer, { headers });
    }
  } catch {}

  // Fallback to one of our static images for consistent UX
  try {
    const fallback = join(process.cwd(), "public", "uploads", "images", "helix-1.jpg");
    const buf = await readFile(fallback);
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=604800, immutable");
    const arrayBuffer = new ArrayBuffer(buf.byteLength);
    new Uint8Array(arrayBuffer).set(buf);
    return new Response(arrayBuffer, { headers });
  } catch {
    return NextResponse.json({ error: "Artwork not found" }, { status: 404 });
  }
}


