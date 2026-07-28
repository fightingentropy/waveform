export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

type RequestTimeoutOptions = {
  timeoutMs: number;
  signal?: AbortSignal | null;
  message?: string;
};

// Run a request with a real client-side deadline. The Promise race makes the
// caller responsive even on a transport that is slow to surface AbortError,
// while the linked controller still cancels the native request and releases its
// socket/body resources. A caller-supplied signal remains authoritative.
export async function withRequestTimeout<T>(
  request: (signal: AbortSignal | undefined) => Promise<T>,
  { timeoutMs, signal: callerSignal, message = "Request timed out. Please try again." }: RequestTimeoutOptions,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }

  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const signal = controller?.signal ?? callerSignal ?? undefined;
  let timedOut = false;
  let timeoutError: RequestTimeoutError | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const forwardAbort = () => controller?.abort();
  if (callerSignal?.aborted) {
    forwardAbort();
  } else {
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const deadline = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutError = new RequestTimeoutError(message, timeoutMs);
        controller?.abort();
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      return await Promise.race([request(signal), deadline]);
    } catch (error) {
      // Some native fetch implementations reject synchronously from abort and
      // can win the race by a microtask. Keep the stable timeout error contract.
      if (timedOut && timeoutError) throw timeoutError;
      throw error;
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}
