import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Needed for parsing MP3 metadata in the artwork API route
  serverExternalPackages: ["music-metadata"],
  // Include SQLite DB and local media when bundling serverless functions
  outputFileTracingIncludes: {
    "/": ["prisma/schema.prisma", "prisma/dev.db", "public/uploads/**"],
    "/liked": ["prisma/schema.prisma", "prisma/dev.db", "public/uploads/**"],
    "/playlist/[id]": ["prisma/schema.prisma", "prisma/dev.db", "public/uploads/**"],
    "/settings": ["prisma/schema.prisma", "prisma/dev.db"],
    "/signin": ["prisma/schema.prisma", "prisma/dev.db"],
    "/register": ["prisma/schema.prisma", "prisma/dev.db"],
    "/upload": ["prisma/schema.prisma", "prisma/dev.db", "public/uploads/**"],
    "/api/auth/[...nextauth]": ["prisma/schema.prisma", "prisma/dev.db"],
    "/api/register": ["prisma/schema.prisma", "prisma/dev.db"],
    "/api/songs": ["prisma/schema.prisma", "prisma/dev.db", "public/uploads/**"],
    "/api/artwork/[...file]": ["public/uploads/**"],
  },
  // We serve images as static files without Next Image optimization
  images: { unoptimized: true },
};

export default nextConfig;
