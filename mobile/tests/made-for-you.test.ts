import { describe, expect, test } from "bun:test";
import {
  buildMadeForYouSongs,
  madeForYouRotationKey,
} from "../src/lib/made-for-you";
import type { PlayerSong } from "../src/types/player";

function song(id: string, artist: string, title = id): PlayerSong {
  return {
    id,
    title,
    artist,
    imageUrl: `/cover/${id}`,
    audioUrl: `/audio/${id}`,
  };
}

const aHit = song("a-hit", "Artist A", "The Hit");
const aCut = song("a-cut", "Artist A", "Album Cut");
const bHit = song("b-hit", "Artist B", "Big Song");
const cSong = song("c-song", "Artist C", "Quiet Find");

function build(
  kind: Parameters<typeof buildMadeForYouSongs>[0],
  overrides: Partial<Parameters<typeof buildMadeForYouSongs>[1]> = {},
) {
  return buildMadeForYouSongs(kind, {
    librarySongs: [aHit, aCut, bHit, cSong],
    readyOfflineSongs: [aHit, cSong],
    recentlyPlayed: [aHit],
    mostPlayed: [{ song: aHit, playCount: 8 }, { song: bHit, playCount: 4 }],
    likedSongIds: new Set([aHit.id, aCut.id, cSong.id]),
    rotationKey: "2026-08-21",
    ...overrides,
  });
}

describe("made-for-you playlists", () => {
  test("Daily Mix combines familiar music with fresh recommendations without duplicates", () => {
    const fresh = song("fresh", "Artist D", "Fresh Find");
    const duplicate = song("fresh-copy", "Artist D", "Fresh Find");
    const result = build("daily", { recommendations: [fresh, duplicate] });

    expect(result.map((item) => item.id)).toContain(aHit.id);
    expect(result.map((item) => item.id)).toContain(fresh.id);
    expect(result.map((item) => item.id)).not.toContain(duplicate.id);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });

  test("Rediscover excludes the recent rotation when alternatives exist", () => {
    const result = build("rediscover");
    expect(result.map((item) => item.id)).not.toContain(aHit.id);
    expect(result.map((item) => item.id)).toContain(bHit.id);
    expect(result.map((item) => item.id)).toContain(cSong.id);
  });

  test("Offline Mix contains only explicitly downloaded songs", () => {
    const result = build("offline");
    expect(new Set(result.map((item) => item.id))).toEqual(new Set([aHit.id, cSong.id]));
  });

  test("Deep Cuts prioritizes less-played music by established artists", () => {
    const result = build("deep-cuts");
    expect(result[0]?.id).toBe(aCut.id);
    expect(result.map((item) => item.id)).not.toContain(aHit.id);
  });

  test("rotation keys are daily for active mixes and weekly for slower shelves", () => {
    const friday = new Date("2026-08-21T12:00:00Z");
    const saturday = new Date("2026-08-22T12:00:00Z");
    expect(madeForYouRotationKey("daily", friday)).not.toBe(
      madeForYouRotationKey("daily", saturday),
    );
    expect(madeForYouRotationKey("rediscover", friday)).toBe(
      madeForYouRotationKey("rediscover", saturday),
    );
  });
});
