// Keep in sync with db/d1-schema.sql and numbered files in db/d1-migrations/.
// Local preview applies these statements via ensureSchema; production uses Wrangler migrations.
export const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" TEXT,
  "name" TEXT,
  "image" TEXT,
  "passwordHash" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "refresh_token" TEXT,
  "access_token" TEXT,
  "expires_at" INTEGER,
  "token_type" TEXT,
  "scope" TEXT,
  "id_token" TEXT,
  "session_state" TEXT,
  UNIQUE ("provider", "providerAccountId"),
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionToken" TEXT NOT NULL UNIQUE,
  "userId" TEXT NOT NULL,
  "expires" TEXT NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "VerificationToken" (
  "identifier" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "expires" TEXT NOT NULL,
  UNIQUE ("identifier", "token")
);

CREATE TABLE IF NOT EXISTS "Song" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "artist" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "audioUrl" TEXT NOT NULL,
  "lyricsUrl" TEXT,
  "duration" REAL,
  "audioBitDepth" INTEGER,
  "audioSampleRate" INTEGER,
  "album" TEXT,
  "albumArtist" TEXT,
  "releaseDate" TEXT,
  "trackNumber" INTEGER,
  "totalTracks" INTEGER,
  "discNumber" INTEGER,
  "totalDiscs" INTEGER,
  "genre" TEXT,
  "isrc" TEXT,
  "upc" TEXT,
  "composer" TEXT,
  "publisher" TEXT,
  "copyright" TEXT,
  "outputFormat" TEXT DEFAULT 'flac',
  "userId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Playlist" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "imageUrl" TEXT,
  "userId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT,
  "convertedAt" TEXT,
  "deletedAt" TEXT,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PlaylistSong" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "playlistId" TEXT NOT NULL,
  "songId" TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  UNIQUE ("playlistId", "songId"),
  FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Like" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "songId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId", "songId"),
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "LikeBackfill" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "completedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PlaybackState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "deviceId" TEXT,
  "stateJson" TEXT NOT NULL,
  "clientUpdatedAt" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "RateLimit" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 0,
  "resetAt" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "PlayEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "songId" TEXT NOT NULL,
  "songJson" TEXT NOT NULL,
  "durationMs" INTEGER,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_song_title" ON "Song" ("title");
CREATE INDEX IF NOT EXISTS "idx_song_createdAt" ON "Song" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_song_userId_createdAt" ON "Song" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_playlist_userId_createdAt" ON "Playlist" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_playlistsong_playlist_order" ON "PlaylistSong" ("playlistId", "order");
CREATE INDEX IF NOT EXISTS "idx_like_userId_createdAt" ON "Like" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_playbackstate_userId_updatedAt" ON "PlaybackState" ("userId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_session_userId" ON "Session" ("userId");
CREATE INDEX IF NOT EXISTS "idx_ratelimit_resetAt" ON "RateLimit" ("resetAt");
CREATE INDEX IF NOT EXISTS "idx_playevent_userId_createdAt" ON "PlayEvent" ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_playevent_userId_songId" ON "PlayEvent" ("userId", "songId");
CREATE INDEX IF NOT EXISTS "idx_account_userId" ON "Account" ("userId");

CREATE TABLE IF NOT EXISTS "SongRef" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "artist" TEXT NOT NULL,
  "album" TEXT,
  "imageUrl" TEXT NOT NULL DEFAULT '',
  "audioUrl" TEXT NOT NULL DEFAULT '',
  "lyricsUrl" TEXT,
  "duration" REAL,
  "audioBitDepth" INTEGER,
  "audioSampleRate" INTEGER,
  "localPath" TEXT,
  "userId" TEXT NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_songref_userId" ON "SongRef" ("userId");
`;

export const D1_SCHEMA_STATEMENTS = D1_SCHEMA_SQL
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
