const { PrismaClient } = require("../src/generated/prisma");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const email = "demo@example.com";
  const passwordHash = await bcrypt.hash("password", 10);

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
    {
      title: "SoundHelix Song 1",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-1.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-1.mp3",
    },
    {
      title: "SoundHelix Song 2",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-2.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-2.mp3",
    },
    {
      title: "SoundHelix Song 3",
      artist: "SoundHelix",
      imageUrl: "/uploads/images/helix-3.jpg",
      audioUrl: "/uploads/audio/soundhelix-song-3.mp3",
    },
  ];

  for (const s of songs) {
    const exists = await prisma.song.findFirst({ where: { audioUrl: s.audioUrl } });
    if (!exists) {
      await prisma.song.create({ data: { ...s, userId: user.id } });
    }
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


