"use client";

import { useState, useRef } from "react";
import { upload } from "@vercel/blob/client";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function UploadPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (status === "loading") {
    return <div className="max-w-md mx-auto py-16 px-4">Loading…</div>;
  }
  if (!session) {
    return (
      <div className="max-w-md mx-auto py-16 px-4">
        <p className="mb-4">You must be signed in to upload songs.</p>
        <a className="underline" href="/signin">Sign in</a>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title || !artist || !image || !audio) {
      setError("All fields are required");
      return;
    }
    setLoading(true);
    try {
      // 1) Upload files directly to Blob using presigned token handler
      const [imageBlob, audioBlob] = await Promise.all([
        upload(image.name, image, { access: "public", handleUploadUrl: "/api/songs/upload-url" }),
        upload(audio.name, audio, { access: "public", handleUploadUrl: "/api/songs/upload-url" }),
      ]);

      // 2) Create DB row using the returned Blob URLs
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, artist, imageUrl: imageBlob.url, audioUrl: audioBlob.url }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Upload failed");
      router.push("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-16 px-4">
      <h1 className="text-2xl font-semibold mb-6">Upload a song</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Artist</label>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Cover image</label>
          <input type="file" accept="image/*" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <label className="block text-sm mb-1">Audio file</label>
          <input type="file" accept="audio/*" onChange={(e) => setAudio(e.target.files?.[0] ?? null)} ref={fileInputRef} />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="h-10 px-4 rounded bg-foreground text-background disabled:opacity-50"
        >
          {loading ? "Uploading…" : "Upload"}
        </button>
      </form>
    </div>
  );
}


