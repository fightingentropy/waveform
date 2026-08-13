export function nativeTransferIdentity(key: string, transferToken: string): string {
  return `${key}\u0000${transferToken}`;
}

export class NativeDownloadRevisionGate {
  private readonly revisions = new Map<string, number>();
  private readonly tombstones = new Set<string>();

  cancel(key: string, transferToken: string): void {
    this.tombstone(nativeTransferIdentity(key, transferToken));
  }

  tombstone(identity: string): void {
    this.tombstones.add(identity);
  }

  clearCancel(key: string, transferToken: string): void {
    this.clearTombstone(nativeTransferIdentity(key, transferToken));
  }

  clearTombstone(identity: string): void {
    this.tombstones.delete(identity);
  }

  knownRevision(key: string, transferToken: string): number {
    return this.revisions.get(nativeTransferIdentity(key, transferToken)) ?? -1;
  }

  shouldApply(key: string, transferToken: string, revision: number): boolean {
    const identity = nativeTransferIdentity(key, transferToken);
    if (this.tombstones.has(identity)) return false;
    return revision >= this.knownRevision(key, transferToken);
  }

  record(key: string, transferToken: string, revision: number): void {
    this.revisions.set(nativeTransferIdentity(key, transferToken), revision);
  }
}
