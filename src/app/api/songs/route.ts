import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const songs = await prisma.song.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(songs);
}

export async function POST(req: Request) {
  const session = (await getServerSession(authOptions as any)) as any;
  if (!session?.user?.email || !session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const title = String(form.get("title") ?? "").trim();
  const artist = String(form.get("artist") ?? "").trim();
  const image = form.get("image") as File | null;
  const audio = form.get("audio") as File | null;

  if (!title || !artist || !image || !audio) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const uploadDir = join(process.cwd(), "public", "uploads");
  const imageDir = join(uploadDir, "images");
  const audioDir = join(uploadDir, "audio");
  await mkdir(imageDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  const imgId = uuidv4();
  const audId = uuidv4();
  const imageFileName = `${imgId}-${image.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const audioFileName = `${audId}-${audio.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;

  const [imageArrayBuffer, audioArrayBuffer] = await Promise.all([
    image.arrayBuffer(),
    audio.arrayBuffer(),
  ]);

  await Promise.all([
    writeFile(join(imageDir, imageFileName), Buffer.from(imageArrayBuffer)),
    writeFile(join(audioDir, audioFileName), Buffer.from(audioArrayBuffer)),
  ]);

  const imageUrl = `/uploads/images/${imageFileName}`;
  const audioUrl = `/uploads/audio/${audioFileName}`;

  const userId = (session as any).user.id as string;
  const song = await prisma.song.create({
    data: { title, artist, imageUrl, audioUrl, userId },
  });

  return NextResponse.json(song, { status: 201 });
}


