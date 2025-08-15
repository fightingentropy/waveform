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
  // Check for admin upload bypass
  const adminKey = req.headers.get("x-admin-key");
  const expectedAdminKey = process.env.ADMIN_UPLOAD_KEY;
  const isAdminUpload = adminKey && expectedAdminKey && adminKey === expectedAdminKey;
  
  let userId: string | null = null;
  
  if (!isAdminUpload) {
    // Regular user upload - require authentication
    const session = await getServerSession(authOptions);
    type AppSession = Session & { user: NonNullable<Session["user"]> & { id: string } };
    const s = session as AppSession | null;
    if (!s?.user?.email || !s.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = s.user.id;
  }

  let title = "";
  let artist = "";
  let imageUrl = "";
  let audioUrl = "";
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await req.json();
    title = String(data?.title ?? "").trim();
    artist = String(data?.artist ?? "").trim();
    imageUrl = String(data?.imageUrl ?? "").trim();
    audioUrl = String(data?.audioUrl ?? "").trim();
  } else {
    const form = await req.formData();
    title = String(form.get("title") ?? "").trim();
    artist = String(form.get("artist") ?? "").trim();
    const image = form.get("image") as File | null;
    const audio = form.get("audio") as File | null;
    if (!image || !audio) {
      return NextResponse.json({ error: "Missing files" }, { status: 400 });
    }
    const imgId = uuidv4();
    const audId = uuidv4();
    const imageFileName = `${imgId}-${image.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const audioFileName = `${audId}-${audio.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const [imageRes, audioRes] = await Promise.all([
      put(`images/${imageFileName}`, image, { access: "public" }),
      put(`audio/${audioFileName}`, audio, { access: "public" }),
    ]);
    imageUrl = imageRes.url;
    audioUrl = audioRes.url;
  }

  if (!title || !artist || !imageUrl || !audioUrl) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const song = await prisma.song.create({ data: { title, artist, imageUrl, audioUrl, userId } });

  return NextResponse.json(song, { status: 201 });
}


