import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { list } from "@vercel/blob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..", "..");

async function loadEnv() {
	const envLocalPath = join(__dirname, ".env.local");
	const envPath = join(__dirname, ".env");
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

function stripRandomSuffixBase(nameWithoutExt) {
	return nameWithoutExt.replace(/-[A-Za-z0-9]{20,}$/i, "");
}

function getBaseFromPathname(pathname) {
	const last = pathname.split("/").pop() || "";
	const noExt = last.replace(/\.[^.]+$/, "");
	return stripRandomSuffixBase(noExt);
}

function isBlobUrl(url) {
	return /^https?:\/\//i.test(url) && /\.vercel-storage\.com\//.test(url);
}

function isTop100Path(urlOrPath) {
	return /\/audio\/top-100\//.test(urlOrPath);
}

async function listAllTop100Blobs() {
	const blobs = [];
	let cursor = undefined;
	// Top 100 is <= 1000, but handle pagination anyway
	do {
		// list() has optional cursor in newer versions; ignore if unsupported
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const opts = { prefix: "audio/top-100/", limit: 1000 };
		if (cursor) opts.cursor = cursor;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const res = await list(opts);
		if (Array.isArray(res?.blobs)) blobs.push(...res.blobs);
		cursor = res?.cursor || res?.pagination?.cursor || undefined;
	} while (cursor);
	return blobs;
}

async function main() {
	await loadEnv();
	if (!process.env.BLOB_READ_WRITE_TOKEN) {
		console.error("BLOB_READ_WRITE_TOKEN is required in env");
		process.exit(1);
	}
	const tursoUrl = process.env.TURSO_DATABASE_URL;
	const tursoToken = process.env.TURSO_AUTH_TOKEN;
	if (!tursoUrl || !tursoToken) {
		console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in env");
		process.exit(1);
	}

	const { PrismaClient } = await import("../src/generated/prisma/index.js");
	const { PrismaLibSQL } = await import("@prisma/adapter-libsql");
	const adapter = new PrismaLibSQL({ url: tursoUrl, authToken: tursoToken });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const prisma = new PrismaClient({ adapter });

	try {
		console.log("Listing Vercel Blob objects under audio/top-100/ ...");
		const blobs = await listAllTop100Blobs();
		console.log(`Found ${blobs.length} blob objects.`);

		// Build map: base (without suffix) -> latest blob URL
		const baseToBlob = new Map();
		for (const b of blobs) {
			const base = getBaseFromPathname(b.pathname || b.key || "");
			if (!base) continue;
			// prefer latest by uploadedAt if available
			const prev = baseToBlob.get(base);
			if (!prev) {
				baseToBlob.set(base, b);
			} else {
				const prevTs = new Date(prev?.uploadedAt || prev?.createdAt || 0).getTime();
				const curTs = new Date(b?.uploadedAt || b?.createdAt || 0).getTime();
				if (curTs >= prevTs) baseToBlob.set(base, b);
			}
		}

		console.log("Fetching songs from database ...");
		const songs = await prisma.song.findMany({ orderBy: { createdAt: "asc" } });

		let updates = 0;
		let duplicatesDeleted = 0;

		// Deduplicate by (title, artist)
		const groups = new Map();
		for (const s of songs) {
			const key = `${s.title}\u0000${s.artist}`;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(s);
		}
		for (const [key, listSongs] of groups.entries()) {
			if (listSongs.length <= 1) continue;
			// keep the earliest createdAt (first due to asc order), delete the rest
			const [keep, ...rest] = listSongs;
			for (const del of rest) {
				await prisma.song.delete({ where: { id: del.id } });
				duplicatesDeleted++;
				console.log(`Deleted duplicate: ${keep.title} - ${keep.artist} (id=${del.id})`);
			}
		}

		// Refresh list after deletions
		const freshSongs = await prisma.song.findMany();

		for (const s of freshSongs) {
			let base = "";
			if (isBlobUrl(s.audioUrl) && isTop100Path(s.audioUrl)) {
				try {
					const urlObj = new URL(s.audioUrl);
					base = getBaseFromPathname(urlObj.pathname);
				} catch {}
			} else if (isTop100Path(s.audioUrl)) {
				// Local path like /uploads/audio/top 100/<file>.mp3 → sanitize underscores already in blob keys
				const last = s.audioUrl.split("/").pop() || "";
				const noExt = last.replace(/\.[^.]+$/, "");
				// Replace all non [a-zA-Z0-9._-] with _ to mirror sanitizeFileName
				const sanitized = noExt.replace(/[^a-zA-Z0-9.\-_]/g, "_");
				base = sanitized;
			}

			if (!base) continue;
			const blob = baseToBlob.get(base);
			if (!blob) continue;
			const newUrl = blob.url || blob.downloadUrl || null;
			if (!newUrl) continue;
			if (s.audioUrl !== newUrl) {
				await prisma.song.update({ where: { id: s.id }, data: { audioUrl: newUrl } });
				updates++;
				console.log(`Updated audioUrl for: ${s.title} - ${s.artist}`);
			}
		}

		console.log(`Done. Updated ${updates} songs. Deleted ${duplicatesDeleted} duplicate rows.`);
		await prisma.$disconnect();
	} catch (err) {
		console.error(err);
		try { await prisma.$disconnect(); } catch {}
		process.exit(1);
	}
}

main();


