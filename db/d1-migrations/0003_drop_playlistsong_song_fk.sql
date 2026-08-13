-- Drop PlaylistSong.songId → Song. Playlist membership stores SongRef and
-- local-library ids that are not rows in Song, so that FK rejects every insert.
-- Idempotent on databases that already match 0001: the replacement table has
-- the same columns and only the playlistId foreign key.

CREATE TABLE IF NOT EXISTS "PlaylistSong_new" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "playlistId" TEXT NOT NULL,
  "songId" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  UNIQUE ("playlistId", "songId"),
  FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT OR IGNORE INTO "PlaylistSong_new" ("id", "playlistId", "songId", "order")
SELECT "id", "playlistId", "songId", "order" FROM "PlaylistSong";

DROP TABLE "PlaylistSong";

ALTER TABLE "PlaylistSong_new" RENAME TO "PlaylistSong";

CREATE INDEX IF NOT EXISTS "idx_playlistsong_playlist_order" ON "PlaylistSong" ("playlistId", "order");
