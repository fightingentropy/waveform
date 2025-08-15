import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hash } from "bcryptjs";

export async function POST(req: Request) {
  // In production demo, prevent writes on read-only SQLite
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Registration is disabled in the demo deployment." },
      { status: 501 }
    );
  }
  const { name, email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  const existing = await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } });
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }
  const passwordHash = await hash(String(password), 10);
  await prisma.user.create({
    data: {
      email: String(email).toLowerCase(),
      name: name ? String(name) : null,
      passwordHash,
    },
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}


