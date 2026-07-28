export type AccountScopedDownload = {
  accountScope: string;
  songId: string;
};

export function planOfflineAccountDeletion<T extends AccountScopedDownload>(
  records: T[],
  accountScope: string,
): {
  deleting: T[];
  retainedSongIds: Set<string>;
} {
  return {
    deleting: records.filter((record) => record.accountScope === accountScope),
    retainedSongIds: new Set(
      records
        .filter((record) => record.accountScope !== accountScope)
        .map((record) => record.songId),
    ),
  };
}
