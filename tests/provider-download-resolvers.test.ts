import { describe, expect, test } from "bun:test";
import {
  getPlatformLink,
  parseSongLinkMetadata,
  parseSongLinkNextDataHtml,
  parseSongstatsSameAsLinks,
  parseSpotiflacStatusPayload,
} from "../src/worker/provider-download";

const TRACK_ID = "7gLT8aVOkQkXQk2yTkZzhF";

const songLinkNextData = {
  props: {
    pageProps: {
      pageData: {
        entityData: {
          title: "Ti Thelo Ego Me Sena",
          artistName: "Giorgos Sabanis",
          thumbnailUrl: "https://image.example/cover.jpg",
          isrc: "GRPA12600295",
        },
        sections: [
          {
            links: [
              { platform: "spotify", url: `https://open.spotify.com/track/${TRACK_ID}` },
              { platform: "tidal", url: "https://listen.tidal.com/track/528127333" },
              { platform: "deezer", url: null },
              { platform: "amazonMusic", url: "" },
              { platform: "yandex", url: "https://music.yandex.ru/track/151855927" },
            ],
          },
        ],
      },
    },
  },
};

describe("song.link HTML scrape (SpotiFLAC 7.2.2)", () => {
  test("reads ISRC and Tidal from __NEXT_DATA__", () => {
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(songLinkNextData)}</script></html>`;
    const payload = parseSongLinkNextDataHtml(html, TRACK_ID);
    expect(payload).toBeTruthy();
    expect(parseSongLinkMetadata(payload!, TRACK_ID)).toEqual({
      title: "Ti Thelo Ego Me Sena",
      artist: "Giorgos Sabanis",
      imageUrl: "https://image.example/cover.jpg",
    });
    expect(getPlatformLink(payload!, "tidal")).toEqual({
      url: "https://listen.tidal.com/track/528127333",
      entityUniqueId: "TIDAL_SONG::528127333",
    });
    expect(getPlatformLink(payload!, "deezer")).toBeNull();
    expect((payload?.entitiesByUniqueId as Record<string, { isrc?: string }>)[`SPOTIFY_SONG::${TRACK_ID}`]?.isrc).toBe(
      "GRPA12600295",
    );
  });

  test("returns null when the page has no NEXT_DATA island", () => {
    expect(parseSongLinkNextDataHtml("<html><body>blocked</body></html>", TRACK_ID)).toBeNull();
  });
});

describe("songstats JSON-LD fallback", () => {
  test("collects Tidal, Amazon, and Deezer sameAs links", () => {
    const html = `
      <script type="application/ld+json">
        {"sameAs":["https://listen.tidal.com/track/111","https://music.amazon.com/tracks/B0EXAMPLE1","https://www.deezer.com/track/4045861971"]}
      </script>
    `;
    expect(parseSongstatsSameAsLinks(html)).toEqual({
      tidal: "https://listen.tidal.com/track/111",
      amazonMusic: "https://music.amazon.com/tracks/B0EXAMPLE1",
      deezer: "https://www.deezer.com/track/4045861971",
    });
  });
});

describe("spotbye status payload", () => {
  test("reads the current next.status wrapper", () => {
    expect(
      parseSpotiflacStatusPayload({
        next: {
          status: { tidal_a: "up", amazon_a: "down", qobuz_x: "UP" },
        },
      }),
    ).toEqual({
      tidal_a: "up",
      amazon_a: "down",
      qobuz_x: "up",
    });
  });

  test("still accepts the legacy top-level status object", () => {
    expect(parseSpotiflacStatusPayload({ status: { deezer_e: "up" } })).toEqual({ deezer_e: "up" });
  });

  test("reads the 7.2 community status object", () => {
    expect(
      parseSpotiflacStatusPayload({
        spotiflac: { status: { tidal: "up", qobuz: "down", amazon: "UP" } },
      }),
    ).toEqual({
      tidal: "up",
      qobuz: "down",
      amazon: "up",
    });
  });
});
