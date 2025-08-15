import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/auth";
import { put } from "@vercel/blob";
import { v4 as uuidv4 } from "uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const songs = await prisma.song.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(songs);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  type AppSession = Session & { user: NonNullable<Session["user"]> & { id: string } };
  const s = session as AppSession | null;
  if (!s?.user?.email || !s.user.id) {
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

  const imgId = uuidv4();
  const audId = uuidv4();
  const imageFileName = `${imgId}-${image.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
  const audioFileName = `${audId}-${audio.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;

  // Upload to Vercel Blob (requires BLOB_READ_WRITE_TOKEN in env)
  const [imageRes, audioRes] = await Promise.all([
    put(`images/${imageFileName}`, image, { access: "public" }),
    put(`audio/${audioFileName}`, audio, { access: "public" }),
  ]);

  const imageUrl = imageRes.url;
  const audioUrl = audioRes.url;

  const userId = s.user.id;
  const song = await prisma.song.create({
    data: { title, artist, imageUrl, audioUrl, userId },
  });

  return NextResponse.json(song, { status: 201 });
}


