import { PrismaClient } from "@/generated/prisma";
import { PrismaLibSQL } from "@prisma/adapter-libsql";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

function createPrisma(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (tursoUrl && tursoToken) {
    const adapter = new PrismaLibSQL({ url: tursoUrl, authToken: tursoToken });
    // We intentionally cast here because the adapter option is not yet in our local Prisma types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new PrismaClient({ adapter } as any);
  }
  return new PrismaClient();
}

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

const prismaClient = globalThis.prismaGlobal ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = prismaClient;
}

export const prisma = prismaClient;


