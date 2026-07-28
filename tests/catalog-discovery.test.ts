import { describe, expect, test } from "bun:test";
import {
  isSpotifyCatalogId,
  parseSpotifyArtistCatalogPayload,
  parseSpotifyArtistEmbedPayload,
  parseSpotifyPathfinderSearchEntities,
  parseSpotifyWebApiSearchEntities,
} from "../src/lib/spotify-pathfinder";
import { parseYouTubePlaylistSearchPayload } from "../src/worker/index";

const ARTIST_ID = "4Z8W4fKeB5YxbusRsdQVPb";
const OTHER_ARTIST_ID = "06HL4z0CvFAxyc27GXpf02";
const PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M";
const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQC";

describe("Spotify catalog ID validation", () => {
  test("accepts only Spotify's 22-character base62 IDs", () => {
    expect(isSpotifyCatalogId(ARTIST_ID)).toBe(true);
    expect(isSpotifyCatalogId(`${ARTIST_ID}x`)).toBe(false);
    expect(isSpotifyCatalogId("not-an-id")).toBe(false);
    expect(isSpotifyCatalogId("../playlist")).toBe(false);
  });
});

describe("Spotify mixed-search entity parsing", () => {
  test("reads only dedicated Pathfinder playlist and artist sections", () => {
    const payload = {
      data: {
        searchV2: {
          tracksV2: {
            items: [
              {
                item: {
                  data: {
                    uri: `spotify:track:${TRACK_ID}`,
                    name: "Track",
                    artists: {
                      items: [
                        {
                          uri: `spotify:artist:${OTHER_ARTIST_ID}`,
                          profile: { name: "Track Credit Only" },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
          playlists: {
            items: [
              {
                data: {
                  uri: `spotify:playlist:${PLAYLIST_ID}`,
                  name: "Today's Hits",
                  description: "Provider description",
                  ownerV2: { data: { name: "Spotify" } },
                  content: { totalCount: 50 },
                  images: {
                    items: [
                      {
                        sources: [
                          { url: "https://i.scdn.co/small.jpg", width: 64 },
                          { url: "https://i.scdn.co/large.jpg", width: 640 },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
          artists: {
            items: [
              {
                data: {
                  uri: `spotify:artist:${ARTIST_ID}`,
                  profile: { name: "Radiohead" },
                  visuals: {
                    avatarImage: {
                      sources: [{ url: "https://i.scdn.co/artist.jpg", width: 320 }],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    const parsed = parseSpotifyPathfinderSearchEntities(payload);
    expect(parsed.playlists).toEqual([
      {
        kind: "playlist",
        provider: "spotify",
        id: PLAYLIST_ID,
        name: "Today's Hits",
        imageUrl: "https://i.scdn.co/large.jpg",
        description: "Provider description",
        ownerName: "Spotify",
        trackCount: 50,
        externalUrl: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      },
    ]);
    expect(parsed.artists).toEqual([
      {
        kind: "artist",
        provider: "spotify",
        id: ARTIST_ID,
        name: "Radiohead",
        imageUrl: "https://i.scdn.co/artist.jpg",
        externalUrl: `https://open.spotify.com/artist/${ARTIST_ID}`,
      },
    ]);
    expect(parsed.artists.some((artist) => artist.id === OTHER_ARTIST_ID)).toBe(false);
  });

  test("parses official Web API summaries and omits absent optional metadata", () => {
    const parsed = parseSpotifyWebApiSearchEntities({
      playlists: {
        items: [
          {
            id: PLAYLIST_ID,
            name: "Focus",
            images: [{ url: "https://i.scdn.co/focus.jpg", width: 300 }],
            owner: { display_name: "Spotify" },
            tracks: { total: 80 },
          },
        ],
      },
      artists: {
        items: [{ id: ARTIST_ID, name: "Radiohead", images: [] }],
      },
    });
    expect(parsed.playlists[0]).toMatchObject({
      id: PLAYLIST_ID,
      name: "Focus",
      ownerName: "Spotify",
      trackCount: 80,
    });
    expect(parsed.artists[0]).toEqual({
      kind: "artist",
      provider: "spotify",
      id: ARTIST_ID,
      name: "Radiohead",
      imageUrl: null,
      externalUrl: `https://open.spotify.com/artist/${ARTIST_ID}`,
    });
  });
});

describe("Spotify artist profile parsing", () => {
  test("parses the authoritative Spotify embed artist and ID-scoped top tracks", () => {
    const result = parseSpotifyArtistEmbedPayload(
      {
        props: {
          pageProps: {
            state: {
              data: {
                entity: {
                  type: "artist",
                  id: ARTIST_ID,
                  uri: `spotify:artist:${ARTIST_ID}`,
                  name: "Radiohead",
                  visualIdentity: {
                    image: [
                      { url: "https://i.scdn.co/small.jpg", maxWidth: 160 },
                      { url: "https://i.scdn.co/large.jpg", maxWidth: 640 },
                    ],
                  },
                  trackList: [
                    {
                      uri: `spotify:track:${TRACK_ID}`,
                      title: "Creep",
                      subtitle: "Radiohead",
                      duration: 238_640,
                      isPlayable: true,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      ARTIST_ID,
    );
    expect(result?.artist).toMatchObject({
      id: ARTIST_ID,
      name: "Radiohead",
      imageUrl: "https://i.scdn.co/large.jpg",
    });
    expect(result?.tracks).toEqual([
      {
        id: TRACK_ID,
        name: "Creep",
        artists: ["Radiohead"],
        imageUrl: "https://i.scdn.co/large.jpg",
        durationMs: 238_640,
      },
    ]);
  });

  test("keeps authoritative profile fields and only artist-scoped top tracks", () => {
    const result = parseSpotifyArtistCatalogPayload(
      {
        id: ARTIST_ID,
        name: "Radiohead",
        genres: ["alternative rock", "art rock"],
        followers: { total: 1234 },
        images: [{ url: "https://i.scdn.co/radiohead.jpg", width: 640 }],
      },
      {
        tracks: [
          {
            id: TRACK_ID,
            name: "Everything In Its Right Place",
            artists: [{ id: ARTIST_ID, name: "Radiohead" }],
            album: {
              name: "Kid A",
              images: [{ url: "https://i.scdn.co/kida.jpg", width: 640 }],
            },
            duration_ms: 251_000,
          },
          {
            id: "0VjIjW4GlUZAMYd2vXMi3b",
            name: "Wrong artist response",
            artists: [{ id: OTHER_ARTIST_ID, name: "Someone Else" }],
          },
        ],
      },
      ARTIST_ID,
    );

    expect(result?.artist).toMatchObject({
      id: ARTIST_ID,
      name: "Radiohead",
      genres: ["alternative rock", "art rock"],
      followers: 1234,
    });
    expect(result?.tracks.map((track) => track.id)).toEqual([TRACK_ID]);
    expect(result?.tracks[0]).toMatchObject({
      name: "Everything In Its Right Place",
      artists: ["Radiohead"],
      album: "Kid A",
      durationMs: 251_000,
    });
  });

  test("rejects a profile whose ID does not match the requested route", () => {
    expect(
      parseSpotifyArtistCatalogPayload(
        { id: OTHER_ARTIST_ID, name: "Someone Else" },
        { tracks: [] },
        ARTIST_ID,
      ),
    ).toBeNull();
  });
});

describe("YouTube playlist search boundary", () => {
  test("accepts bounded provider rows without upgrading untrusted artwork", () => {
    const parsed = parseYouTubePlaylistSearchPayload({
      provider: "youtube",
      playlists: [
        {
          id: "PL123456789",
          name: "Live Sessions",
          imageUrl: "https://i.ytimg.com/cover.jpg",
          ownerName: "Channel",
        },
        {
          id: "PLabcdefgh",
          name: "Unsafe thumbnail",
          imageUrl: "http://example.com/cover.jpg",
        },
        { id: "../bad", name: "Bad" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      provider: "youtube",
      id: "PL123456789",
      imageUrl: "https://i.ytimg.com/cover.jpg",
      ownerName: "Channel",
    });
    expect(parsed[1]?.imageUrl).toBeNull();
  });
});
