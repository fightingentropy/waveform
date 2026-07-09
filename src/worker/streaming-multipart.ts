const DEFAULT_PEEK_BYTES = 64 * 1024;

function concatPrefix(chunks: Uint8Array[], limit: number): Uint8Array {
  const length = Math.min(limit, chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  const prefix = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, length - offset));
    prefix.set(slice, offset);
    offset += slice.byteLength;
  }
  return prefix;
}

export async function peekAndReplayStream(
  source: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    peekBytes?: number;
    onProgress?: (received: number) => void;
  },
): Promise<{ prefix: Uint8Array; body: ReadableStream<Uint8Array> }> {
  const peekBytes = Math.max(1, options.peekBytes ?? DEFAULT_PEEK_BYTES);
  const reader = source.getReader();
  const initialChunks: Uint8Array[] = [];
  let initialBytes = 0;
  let sourceDone = false;

  try {
    while (initialBytes < peekBytes) {
      const { done, value } = await reader.read();
      if (done) {
        sourceDone = true;
        break;
      }
      if (!value?.byteLength) continue;
      initialBytes += value.byteLength;
      if (initialBytes > options.maxBytes) {
        await reader.cancel("Audio file is too large").catch(() => undefined);
        throw new Error("Audio file is too large");
      }
      initialChunks.push(value);
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  let initialIndex = 0;
  let replayedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (initialIndex < initialChunks.length) {
          const chunk = initialChunks[initialIndex++];
          replayedBytes += chunk.byteLength;
          options.onProgress?.(replayedBytes);
          controller.enqueue(chunk);
          return;
        }
        if (sourceDone) {
          reader.releaseLock();
          controller.close();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          sourceDone = true;
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!value?.byteLength) return;
        replayedBytes += value.byteLength;
        if (replayedBytes > options.maxBytes) {
          await reader.cancel("Audio file is too large").catch(() => undefined);
          reader.releaseLock();
          controller.error(new Error("Audio file is too large"));
          return;
        }
        options.onProgress?.(replayedBytes);
        controller.enqueue(value);
      } catch (error) {
        try {
          reader.releaseLock();
        } catch {}
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {}
    },
  });

  return { prefix: concatPrefix(initialChunks, peekBytes), body };
}

function quoteMultipartHeader(value: string): string {
  return value.replace(/[\r\n"]/g, "_");
}

export function createStreamingMultipartBody(options: {
  boundary?: string;
  fields: Record<string, string>;
  file: {
    fieldName: string;
    fileName: string;
    contentType: string;
    body: ReadableStream<Uint8Array>;
  };
}): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = options.boundary || `----spotify-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  let preamble = "";
  for (const [name, value] of Object.entries(options.fields)) {
    preamble += `--${boundary}\r\n`;
    preamble += `Content-Disposition: form-data; name="${quoteMultipartHeader(name)}"\r\n\r\n`;
    preamble += `${value}\r\n`;
  }
  preamble += `--${boundary}\r\n`;
  preamble += `Content-Disposition: form-data; name="${quoteMultipartHeader(options.file.fieldName)}"; filename="${quoteMultipartHeader(options.file.fileName)}"\r\n`;
  preamble += `Content-Type: ${options.file.contentType || "application/octet-stream"}\r\n\r\n`;

  const prefix = encoder.encode(preamble);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = options.file.body.getReader();
  let phase: "prefix" | "file" | "done" = "prefix";

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (phase === "prefix") {
          phase = "file";
          controller.enqueue(prefix);
          return;
        }
        if (phase === "done") {
          controller.close();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          phase = "done";
          reader.releaseLock();
          controller.enqueue(suffix);
          controller.close();
          return;
        }
        if (value?.byteLength) controller.enqueue(value);
      } catch (error) {
        try {
          reader.releaseLock();
        } catch {}
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {}
    },
  });

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
