import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import LibrarySidebarClient from "../src/components/LibrarySidebarClient";

describe("desktop library sidebar", () => {
  test("links to the dedicated playlists grid instead of the Library view", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <LibrarySidebarClient initialCollapsed={false} />
      </MemoryRouter>,
    );

    expect(markup).toContain('href="/playlists"');
    expect(markup).not.toContain('href="/library');
    expect(markup.match(/>Playlists</g)).toHaveLength(1);
  });
});
