import { readdir, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import { parseFile } from "music-metadata";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..", "..");

async function* walkDirectory(directoryPath) {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			yield* walkDirectory(fullPath);
		} else {
			yield fullPath;
		}
	}
}

function parseArtistAndTitle(fileName) {
	const withoutExt = fileName.replace(/\.[^.]+$/, "");
	const withoutIndex = withoutExt.replace(/^\s*\d+\.\s*/, "");
	const sep = " - ";
	const idx = withoutIndex.indexOf(sep);
	if (idx !== -1) {
		const artist = withoutIndex.slice(0, idx).trim();
		const title = withoutIndex.slice(idx + sep.length).trim();
		return { artist: artist || "Unknown", title: title || withoutIndex };
	}
	return { artist: "Unknown", title: withoutIndex.trim() };
}

function sanitizeFileName(name) {
	return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

async function loadEnv() {
	const envLocalPath = join(__dirname, "..", ".env.local");
	const envPath = join(__dirname, "..", ".env");
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
	if (!process.env.BLOB_READ_WRITE_TOKEN) {
		console.error("BLOB_READ_WRITE_TOKEN is required in env");
		process.exit(1);
	}

	const { PrismaClient } = await import("../src/generated/prisma/index.js");
	const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
	const tursoUrl = process.env.TURSO_DATABASE_URL;
	const tursoToken = process.env.TURSO_AUTH_TOKEN;
	if (!tursoUrl || !tursoToken) {
		console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in env");
		process.exit(1);
	}
	const adapter = new PrismaLibSQL({ url: tursoUrl, authToken: tursoToken });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const prisma = new PrismaClient({ adapter });

	const top100Dir = join(__dirname, "public", "uploads", "audio", "top 100");
	try {
		await stat(top100Dir);
	} catch (err) {
		console.error("Directory not found:", top100Dir);
		await prisma.$disconnect();
		process.exit(1);
	}

	const created = [];
	for await (const path of walkDirectory(top100Dir)) {
		if (!path.toLowerCase().endsWith(".mp3")) continue;
		const fileName = path.split("/").pop() || "track.mp3";
		const { artist, title } = parseArtistAndTitle(fileName);

		const audioKey = `audio/top-100/${sanitizeFileName(fileName)}`;
		const audioBuffer = await readFile(path);
		const audioBlob = await put(audioKey, audioBuffer, { access: "public", contentType: "audio/mpeg" });

		let imageUrl = "/uploads/images/helix-1.jpg";
		try {
			const meta = await parseFile(path, { duration: false, skipCovers: false });
			const picture = meta.common.picture?.[0];
			if (picture?.data?.length) {
				const ext = (picture.format || "image/jpeg").includes("png") ? "png" : "jpg";
				const imageKey = `images/${sanitizeFileName(fileName.replace(/\.[^.]+$/, ""))}-cover.${ext}`;
				const imgBlob = await put(imageKey, Buffer.from(picture.data), {
					access: "public",
					contentType: picture.format || "image/jpeg",
				});
				imageUrl = imgBlob.url;
			}
		} catch {}

		const exists = await prisma.song.findFirst({ where: { title, artist } });
		if (!exists) {
			const user = await prisma.user.upsert({ where: { email: "demo@example.com" }, update: {}, create: { email: "demo@example.com", name: "Demo User" } });
			const row = await prisma.song.create({ data: { title, artist, imageUrl, audioUrl: audioBlob.url, userId: user.id } });
			created.push(row);
			console.log("Created:", title, "-", artist);
		} else {
			console.log("Skipped existing:", title, "-", artist);
		}
	}

	await prisma.$disconnect();
	console.log(`Done. Created ${created.length} songs.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
