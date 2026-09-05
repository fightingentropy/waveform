import { describe, expect, test } from "bun:test";
import {
  buildYouTubePlaylistSearchUrl,
  isValidYouTubePlaylistId,
  normalizeYouTubePlaylistSearchQuery,
  parseYouTubePlaylistSearchEntries,
  passesArtistGate,
  pickBestYouTubeMatch,
  scoreYouTubeCandidate,
  splitTitleArtist,
  type YouTubeSearchEntry,
} from "../src/server/youtube-preview";

describe("Discover Mix song metadata", () => {
  test("removes video decorations before separating the artist and title", () => {
    expect(splitTitleArtist('MELISSES x KAS "VIKTORIA" - Official Music Video', "Mix")).toEqual({
      artist: "MELISSES x KAS", title: "VIKTORIA",
    });
    expect(splitTitleArtist("Aspa – Ela (Έλα) | Official Music Video", "Mix")).toEqual({
      artist: "Aspa", title: "Ela (Έλα)",
    });
    expect(splitTitleArtist("Γιώργος Σαμπάνης - Άλλαξε Τα Όλα | Official Video Clip", "Mix")).toEqual({
      artist: "Γιώργος Σαμπάνης", title: "Άλλαξε Τα Όλα",
    });
  });

  test("keeps song versions and uses the supplied artist when there is no separator", () => {
    expect(splitTitleArtist("Artist - Song (Live) [Official Video Clip]", "Mix")).toEqual({
      artist: "Artist", title: "Song (Live)",
    });
    expect(splitTitleArtist("Video Games", "Lana Del Rey")).toEqual({
      artist: "Lana Del Rey", title: "Video Games",
    });
  });
});

// The Smart Shuffle YouTube-preview matcher must be "confident-match-or-nothing":
// it stages a rec's audio only when artist AND (Spotify-known) duration line up.
// These fixtures pin the failure modes found during live validation.

describe("passesArtistGate", () => {
  test("rejects results where the artist never appears (ambiguous title word)", () => {
    // Real failure: searching "Marsh Vetiver" surfaced vetiver-GRASS farming videos.
    const entry: YouTubeSearchEntry = {
      id: "x",
      title: "Why Vetiver Hedgerows are Superior for Soil",
      uploader: "Vetiver Grass - TVNI Webinar",
      duration: 73,
    };
    expect(passesArtistGate({ artist: "Marsh" }, entry)).toBe(false);
  });

  test("accepts a Topic art-track whose channel carries the artist", () => {
    const entry: YouTubeSearchEntry = {
      id: "y",
      title: "Carry Me Higher",
      uploader: "Real Deep - Topic",
      duration: 189,
    };
    expect(passesArtistGate({ artist: "Real Deep" }, entry)).toBe(true);
  });

  test("an empty artist never gates anything out", () => {
    expect(passesArtistGate({ artist: "" }, { id: "z", title: "anything" })).toBe(true);
  });
});

describe("pickBestYouTubeMatch", () => {
  test("returns null when no candidate clears the artist gate", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "a", title: "Why Vetiver Hedgerows are Superior", uploader: "Vetiver Grass - TVNI", duration: 73 },
      { id: "b", title: "Vetiver Grass - A Climate Smart Plant", uploader: "Vetiver Grass - TVNI", duration: 261 },
    ];
    const match = pickBestYouTubeMatch({ title: "Vetiver", artist: "Marsh", durationMs: 230_000 }, entries, 0.5);
    expect(match).toBeNull();
  });

  test("prefers the artist's Topic art-track over a same-title track by a different artist", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "topic", title: "Carry Me Higher", uploader: "Real Deep - Topic", duration: 189 },
      { id: "other", title: "Carry Me Higher (7 Inch Version)", uploader: "The Blessed Madonna", duration: 271 },
    ];
    const match = pickBestYouTubeMatch({ title: "Carry Me Higher", artist: "Real Deep", durationMs: 188_000 }, entries, 0.5);
    expect(match?.videoId).toBe("topic");
  });

  test("duration kills an hour-long Full Album upload that otherwise matches", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "song", title: "Lane 8 - Brightest Lights feat. POLIÇA", uploader: "This Never Happened", duration: 413 },
      { id: "album", title: "Lane 8 - Brightest Lights (Full Album Continuous Mix)", uploader: "This Never Happened", duration: 3549 },
    ];
    const match = pickBestYouTubeMatch({ title: "Brightest Lights", artist: "Lane 8", durationMs: 413_000 }, entries, 0.5);
    expect(match?.videoId).toBe("song");
  });

  test("studio version outranks a live version when the rec isn't 'live'", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "studio", title: "RÜFÜS DU SOL - Innerbloom (Official Video)", uploader: "RÜFÜS DU SOL", duration: 579 },
      { id: "live", title: "RÜFÜS DU SOL - Innerbloom (Live at Red Rocks)", uploader: "RÜFÜS DU SOL", duration: 600 },
    ];
    const opts = { title: "Innerbloom", artist: "RÜFÜS DU SOL", durationMs: 579_000 };
    expect(scoreYouTubeCandidate(opts, entries[0])).toBeGreaterThan(scoreYouTubeCandidate(opts, entries[1]));
    expect(pickBestYouTubeMatch(opts, entries, 0.5)?.videoId).toBe("studio");
  });

  test("accented and case-folded artist/title still match", () => {
    const entries: YouTubeSearchEntry[] = [
      { id: "ok", title: "Ben Böhmer - Breathing", uploader: "Anjunadeep", duration: 223 },
    ];
    const match = pickBestYouTubeMatch({ title: "Breathing", artist: "Ben Bohmer", durationMs: 223_000 }, entries, 0.5);
    expect(match?.videoId).toBe("ok");
  });
});

describe("YouTube playlist search", () => {
  test("normalizes a bounded human query and rejects invalid input", () => {
    expect(normalizeYouTubePlaylistSearchQuery("  daft   punk  ")).toBe("daft punk");
    expect(normalizeYouTubePlaylistSearchQuery("x")).toBeNull();
    expect(normalizeYouTubePlaylistSearchQuery(`ok\u0000bad`)).toBeNull();
    expect(normalizeYouTubePlaylistSearchQuery("x".repeat(101))).toBeNull();
  });

  test("builds a playlist-filtered YouTube search URL", () => {
    const url = new URL(buildYouTubePlaylistSearchUrl("daft punk"));
    expect(url.origin).toBe("https://www.youtube.com");
    expect(url.pathname).toBe("/results");
    expect(url.searchParams.get("search_query")).toBe("daft punk");
    expect(url.searchParams.get("sp")).toBe("EgIQAw%3D%3D");
  });

  test("accepts only authoritative matching playlist URLs and trusted artwork", () => {
    const entries = [
      {
        id: "PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl",
        title: "Daft Punk - Discovery",
        url: "https://www.youtube.com/playlist?list=PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl",
        channel: "Daft Punk",
        thumbnails: [
          { url: "https://i.ytimg.com/vi/one/mqdefault.jpg", width: 320, height: 180 },
          { url: "https://i.ytimg.com/vi/one/hqdefault.jpg", width: 720, height: 404 },
        ],
      },
      // Duplicate id: first authoritative result wins.
      {
        id: "PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl",
        title: "Duplicate",
        url: "https://www.youtube.com/playlist?list=PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl",
      },
      // A mismatched declared id and URL is not authoritative.
      {
        id: "PLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        title: "Mismatched",
        url: "https://www.youtube.com/playlist?list=PLBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      },
      // A video result cannot leak through even if its id happens to match our
      // conservative playlist-id character/length validation.
      {
        id: "abcdefghijk",
        title: "Video",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
      {
        id: "PLdXJrX9OsbOVq2TKvUc3xGUp2Rm8nTUVh",
        title: "Best Of Daft Punk",
        url: "https://www.youtube.com/playlist?list=PLdXJrX9OsbOVq2TKvUc3xGUp2Rm8nTUVh",
        uploader: "Listener",
        thumbnails: [{ url: "https://attacker.example/cover.jpg", width: 1000, height: 1000 }],
      },
    ];

    expect(parseYouTubePlaylistSearchEntries(entries)).toEqual([
      {
        id: "PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl",
        name: "Daft Punk - Discovery",
        imageUrl: "https://i.ytimg.com/vi/one/hqdefault.jpg",
        ownerName: "Daft Punk",
      },
      {
        id: "PLdXJrX9OsbOVq2TKvUc3xGUp2Rm8nTUVh",
        name: "Best Of Daft Punk",
        ownerName: "Listener",
      },
    ]);
  });

  test("validates ids and clamps result count", () => {
    expect(isValidYouTubePlaylistId("PLSdoVPM5WnndLX6Ngmb8wktMF61dJirKl")).toBe(true);
    expect(isValidYouTubePlaylistId("bad/list")).toBe(false);

    const entries = Array.from({ length: 20 }, (_, index) => {
      const id = `PL${String(index).padStart(30, "0")}`;
      return {
        id,
        title: `Playlist ${index}`,
        url: `https://www.youtube.com/playlist?list=${id}`,
      };
    });
    expect(parseYouTubePlaylistSearchEntries(entries, 99)).toHaveLength(12);
  });
});
