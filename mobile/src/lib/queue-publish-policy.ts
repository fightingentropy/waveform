export type QueuePublishMarker = {
  queue: readonly unknown[];
  queueToken: number;
  queueAppendToken: number;
};

/**
 * Queue edits normally need an immediate resume-state snapshot. Background
 * playlist hydration is intentionally different: its page loop writes one
 * trailing snapshot after all appends, so publishing here would repeatedly
 * serialize and upload the whole growing queue.
 */
export function shouldPublishQueueMutation(
  previous: QueuePublishMarker,
  next: QueuePublishMarker,
): boolean {
  if (next.queue === previous.queue) return false;
  const startedNewQueue = next.queueToken !== previous.queueToken;
  const backgroundAppend = next.queueAppendToken !== previous.queueAppendToken;
  return startedNewQueue || !backgroundAppend;
}
