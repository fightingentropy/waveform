import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
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

async function main() {
	if (!process.env.BLOB_READ_WRITE_TOKEN) {
		console.error("BLOB_READ_WRITE_TOKEN is required in env");
		process.exit(1);
	}

	const { PrismaClient } = await import("../src/generated/prisma/index.js");
	const prisma = new PrismaClient();

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
		const audioStream = createReadStream(path);
		const audioBlob = await put(audioKey, audioStream, { access: "public" });

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
