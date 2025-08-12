import { PrismaClient } from "@/generated/prisma";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = "demo@example.com";
  const passwordHash = await hash("password", 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Demo User", passwordHash },
  });

  const songs = [
    {
      title: "Sample Track 3s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-1.jpg",
      audioUrl: "/uploads/audio/sample-3s.mp3",
    },
    {
      title: "Sample Track 6s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-2.jpg",
      audioUrl: "/uploads/audio/sample-6s.mp3",
    },
    {
      title: "Sample Track 12s",
      artist: "Sample Artist",
      imageUrl: "/uploads/images/sample-3.jpg",
      audioUrl: "/uploads/audio/sample-12s.mp3",
    },
  ];

  for (const s of songs) {
    await prisma.song.upsert({
      where: { audioUrl: s.audioUrl },
      update: {},
      create: { ...s, userId: user.id },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seed complete");
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });


