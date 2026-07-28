import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SongGrid } from "../src/components/SongGrid";
import type { PlayerSong } from "../src/types/player";

const song: PlayerSong = {
  id: "song-1",
  title: "Test Song",
  artist: "Test Artist",
  album: "Test Album",
  duration: 185,
  imageUrl: "/cover.jpg",
  audioUrl: "/audio.mp3",
};

describe("web playlist song presentation", () => {
  test("defaults to the compact playlist list without changing the shared grid default", () => {
    const playlistMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <SongGrid songs={[song]} variant="playlist" />
      </MemoryRouter>,
    );
    const defaultMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <SongGrid songs={[song]} />
      </MemoryRouter>,
    );

    expect(playlistMarkup).toContain("Test Album");
    expect(playlistMarkup).toContain("3:05");
    expect(playlistMarkup).toContain(">Title<");
    expect(playlistMarkup).toContain(">Time<");
    expect(defaultMarkup).not.toContain("Test Album");
    expect(defaultMarkup).toContain("wf-song-card");
  });
});
