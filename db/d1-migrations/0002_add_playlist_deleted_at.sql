-- Folder-backed playlists are filesystem views. Deleting one in the app must
-- hide the playlist without deleting its songs or the files on the Mac mini.
ALTER TABLE "Playlist" ADD COLUMN "deletedAt" TEXT;
