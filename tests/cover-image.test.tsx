import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverImage } from "../src/components/CoverImage";

describe("CoverImage fallback", () => {
  test("replaces the legacy branded missing-cover sentinel with neutral artwork", () => {
    const markup = renderToStaticMarkup(
      <CoverImage src="/apple-icon.png" alt="Missing song cover" width={128} height={128} />,
    );

    expect(markup).toContain('src="/music-placeholder.svg?v=2"');
    expect(markup).not.toContain("/apple-icon.png");
  });

  test("keeps a real cover as the primary source", () => {
    const markup = renderToStaticMarkup(
      <CoverImage src="/covers/song.jpg" alt="Song cover" width={128} height={128} />,
    );

    expect(markup).toContain('src="/covers/song.jpg"');
  });
});
