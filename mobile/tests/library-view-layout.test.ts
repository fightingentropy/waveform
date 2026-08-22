import { describe, expect, test } from "bun:test";

const libraryScreen = await Bun.file(
  new URL("../src/app/(tabs)/library.tsx", import.meta.url),
).text();

describe("library view layout", () => {
  test("renders add actions in the selected list or grid layout", () => {
    expect(libraryScreen).toContain("function LibraryAddActionsGrid");
    expect(libraryScreen).toContain(
      '<LibraryAddActionsGrid actions={addActions} cellWidth={cellWidth} />',
    );
    expect(libraryScreen).toContain("<LibraryAddActionsList actions={addActions} />");
  });

  test("shows playlist rows only in the Playlists filter", () => {
    expect(libraryScreen).toContain(
      'if (filter === "playlists") return [liked, ...playlists];',
    );
    expect(libraryScreen).toContain("return [liked, radio, podcastsShortcut, events];");
    expect(libraryScreen).not.toContain(
      "return [liked, radio, podcastsShortcut, events, ...playlists];",
    );
  });
});
