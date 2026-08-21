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
});
