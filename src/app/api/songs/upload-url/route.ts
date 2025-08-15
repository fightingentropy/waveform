import { NextResponse } from "next/server";
import { handleUpload } from "@vercel/blob/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const session = await getServerSession(authOptions);
	if (!session?.user?.email) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const body = await request.json();
		const json = await handleUpload({
			request,
			body,
			onBeforeGenerateToken: async () => ({
				allowedContentTypes: [
					"audio/mpeg",
					"audio/mp3",
					"audio/wav",
					"audio/x-wav",
					"image/jpeg",
					"image/png",
				],
				addRandomSuffix: true,
			}),
			onUploadCompleted: async () => {
				// No-op; client will call /api/songs with returned URLs to create DB row
			},
		});
		return NextResponse.json(json);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Upload URL error";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}
