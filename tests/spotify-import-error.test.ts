import { describe, expect, test } from "bun:test";
import {
  SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE,
  formatSpotifyImportErrorMessage,
} from "../src/lib/spotify-import-error";

describe("Spotify import error formatting", () => {
  test("turns an unavailable SpotiFLAC session into one actionable message", () => {
    expect(
      formatSpotifyImportErrorMessage(
        "No downloadable provider found. tidal: SpotiFLAC community session is not available on this Mac | GDStudio returned 401",
      ),
    ).toBe(SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE);
  });

  test("extracts a community cooldown instead of exposing the fallback chain", () => {
    expect(
      formatSpotifyImportErrorMessage(
        "tidal failed | The server is overloaded and taking a short break. Please try again in about 18 minute(s). | qobuz failed",
      ),
    ).toBe("The server is overloaded and taking a short break. Please try again in about 18 minute(s).");
  });

  test("collapses oversized provider diagnostics", () => {
    const raw = `No downloadable provider found. ${"legacy provider returned 500 | ".repeat(30)}`;
    const message = formatSpotifyImportErrorMessage(raw);
    expect(message).toBe("No lossless download provider is available right now. Please try again later.");
    expect(message.length).toBeLessThan(100);
  });

  test("keeps a short useful error", () => {
    expect(formatSpotifyImportErrorMessage("Invalid Spotify track URL or ID")).toBe(
      "Invalid Spotify track URL or ID",
    );
  });
});
