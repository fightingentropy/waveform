import { describe, expect, test } from "bun:test";

const homeScreen = await Bun.file(
  new URL("../src/app/(tabs)/index.tsx", import.meta.url),
).text();

describe("home content layout", () => {
  test("shows generated playlist cards without exposing listening-history song rows", () => {
    expect(homeScreen).toContain('<SectionTitle title="Made for you" />');
    expect(homeScreen).toContain("MADE_FOR_YOU_DEFINITIONS.map");
    expect(homeScreen).toContain('pathname: "/made-for-you/[kind]"');
    expect(homeScreen).toContain('<SectionTitle title="Discover" />');
    expect(homeScreen).not.toContain("Continue listening");
    expect(homeScreen).not.toContain("Most played");
    expect(homeScreen).not.toContain("/api/stats/home");
  });
});
