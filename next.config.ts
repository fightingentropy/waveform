import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Needed for parsing MP3 metadata in the artwork API route and Turso client
  serverExternalPackages: [
    "music-metadata",
    "@prisma/adapter-libsql",
    "@libsql/client",
    "@libsql/hrana-client",
    "@libsql/isomorphic-fetch",
    "@libsql/isomorphic-ws",
  ],
  // Include SQLite DB and local media when bundling serverless functions
  outputFileTracingIncludes: {
    "/": ["prisma/schema.prisma", "public/uploads/**"],
    "/liked": ["prisma/schema.prisma", "public/uploads/**"],
    "/playlist/[id]": ["prisma/schema.prisma", "public/uploads/**"],
    "/settings": ["prisma/schema.prisma"],
    "/signin": ["prisma/schema.prisma"],
    "/register": ["prisma/schema.prisma"],
    "/upload": ["prisma/schema.prisma", "public/uploads/**"],
    "/api/auth/[...nextauth]": ["prisma/schema.prisma"],
    "/api/register": ["prisma/schema.prisma"],
    "/api/songs": ["prisma/schema.prisma", "public/uploads/**"],
    "/api/artwork/[...file]": ["public/uploads/**"],
  },
  // We serve images as static files without Next Image optimization
  images: { unoptimized: true },
};

export default nextConfig;
