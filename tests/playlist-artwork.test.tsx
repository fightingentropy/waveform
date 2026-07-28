import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaylistArtwork } from "../src/components/PlaylistArtwork";

function renderArtwork(
  coverImageUrls: Array<string | null | undefined>,
  imageUrl?: string | null,
) {
  return renderToStaticMarkup(
    <PlaylistArtwork coverImageUrls={coverImageUrls} imageUrl={imageUrl} />,
  );
}

describe("PlaylistArtwork", () => {
  test("shows the neutral playlist icon when no cover is available", () => {
    const markup = renderArtwork([]);

    expect(markup).toContain("<svg");
    expect(markup).not.toContain("<img");
  });

  test("uses the legacy image as the single-cover fallback", () => {
    const markup = renderArtwork([], "/covers/fallback.jpg");

    expect(markup).toContain('src="/covers/fallback.jpg"');
    expect(markup.match(/<img/g)).toHaveLength(1);
  });

  test("trims, deduplicates, and preserves the first four cover URLs", () => {
    const markup = renderArtwork([
      " /covers/one.jpg ",
      "/covers/two.jpg",
      "",
      "/covers/one.jpg",
      null,
      "/covers/three.jpg",
      "/covers/four.jpg",
      "/covers/five.jpg",
    ]);

    expect(markup.match(/<img/g)).toHaveLength(4);
    expect(markup).toContain('src="/covers/one.jpg"');
    expect(markup).toContain('src="/covers/two.jpg"');
    expect(markup).toContain('src="/covers/three.jpg"');
    expect(markup).toContain('src="/covers/four.jpg"');
    expect(markup).not.toContain("/covers/five.jpg");
  });

  test("uses a two-column split for two covers and the large-left split for three", () => {
    const twoCoverMarkup = renderArtwork(["/covers/one.jpg", "/covers/two.jpg"]);
    const threeCoverMarkup = renderArtwork([
      "/covers/one.jpg",
      "/covers/two.jpg",
      "/covers/three.jpg",
    ]);

    expect(twoCoverMarkup).toContain("grid-cols-2");
    expect(twoCoverMarkup).not.toContain("grid-rows-2");
    expect(threeCoverMarkup).toContain("grid-rows-2");
    expect(threeCoverMarkup).toContain("row-span-2");
  });

  test("only prioritizes the first tile in an eager collage", () => {
    const markup = renderToStaticMarkup(
      <PlaylistArtwork
        coverImageUrls={["/covers/one.jpg", "/covers/two.jpg", "/covers/three.jpg"]}
        loading="eager"
      />,
    );

    expect(markup.match(/loading="eager"/g)).toHaveLength(1);
    expect(markup.match(/loading="lazy"/g)).toHaveLength(2);
  });
});
