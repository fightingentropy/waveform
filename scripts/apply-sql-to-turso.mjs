import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function loadEnv() {
  const envLocalPath = join(process.cwd(), ".env.local");
  const envPath = join(process.cwd(), ".env");
  for (const p of [envLocalPath, envPath]) {
    try {
      const content = await readFile(p, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {}
  }
}

async function main() {
  await loadEnv();
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (!tursoUrl || !tursoToken) {
    console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set");
    process.exit(1);
  }

  const client = createClient({ url: tursoUrl, authToken: tursoToken });

  // Read and apply all Prisma migration SQL files in order
  const migrationsDir = join(process.cwd(), "prisma", "migrations");
  const entriesRaw = await import("node:fs/promises").then((m) => m.readdir(migrationsDir, { withFileTypes: true }));
  const dirs = entriesRaw.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const dir of dirs) {
    const sqlPath = join(migrationsDir, dir, "migration.sql");
    let sql = "";
    try {
      sql = await readFile(sqlPath, "utf8");
    } catch {
      continue;
    }
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        await client.execute(stmt);
      } catch (err) {
        const msg = String(err?.message || err);
        const ignorable =
          msg.includes("already exists") ||
          msg.includes("duplicate column") ||
          msg.includes("UNIQUE constraint failed") ||
          msg.includes("no such table: _prisma_migrations");
        if (!ignorable) {
          console.error(`Failed in migration ${dir}. Statement:`);
          console.error(stmt);
          throw err;
        }
      }
    }
  }

  await client.close();
  console.log("Applied migration SQL to Turso successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


