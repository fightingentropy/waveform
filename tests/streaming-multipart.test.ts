import { describe, expect, test } from "bun:test";
import {
  createStreamingMultipartBody,
  peekAndReplayStream,
} from "../src/worker/streaming-multipart";

function streamChunks(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
}

describe("Worker streaming upload helpers", () => {
  test("peeks at audio bytes and replays the complete stream", async () => {
    const progress: number[] = [];
    const replay = await peekAndReplayStream(streamChunks([[1, 2], [3, 4], [5, 6]]), {
      maxBytes: 10,
      peekBytes: 4,
      onProgress: (received) => progress.push(received),
    });

    expect(Array.from(replay.prefix)).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(await new Response(replay.body).arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([2, 4, 6]);
  });

  test("rejects an unknown-length stream once it exceeds the byte budget", async () => {
    const replay = await peekAndReplayStream(streamChunks([[1, 2], [3, 4], [5, 6]]), {
      maxBytes: 5,
      peekBytes: 2,
    });
    await expect(new Response(replay.body).arrayBuffer()).rejects.toThrow("Audio file is too large");
  });

  test("encodes fields around the streamed file without buffering it", async () => {
    const multipart = createStreamingMultipartBody({
      boundary: "test-boundary",
      fields: { title: "Song", artist: "Artist" },
      file: {
        fieldName: "audio",
        fileName: "Artist - Song.flac",
        contentType: "audio/flac",
        body: streamChunks([[0x66, 0x4c, 0x61, 0x43]]),
      },
    });
    const bytes = new Uint8Array(await new Response(multipart.body).arrayBuffer());
    const text = new TextDecoder().decode(bytes);

    expect(multipart.contentType).toBe("multipart/form-data; boundary=test-boundary");
    expect(text).toContain('name="title"\r\n\r\nSong');
    expect(text).toContain('name="artist"\r\n\r\nArtist');
    expect(text).toContain('name="audio"; filename="Artist - Song.flac"');
    expect(text).toContain("fLaC");
    expect(text.endsWith("\r\n--test-boundary--\r\n")).toBe(true);
  });
});
