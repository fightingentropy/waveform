import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mobileRoot = resolve(import.meta.dir, "..");
const swift = readFileSync(
  resolve(mobileRoot, "modules/audio-engine/ios/AudioEngineModule.swift"),
  "utf8",
);
const bridge = readFileSync(resolve(mobileRoot, "modules/audio-engine/index.ts"), "utf8");

describe("native audio track-event contract", () => {
  test("item-bound Swift events carry the song id captured by prepare", () => {
    expect(swift).toContain('self.sendEvent("error", ["deck": deckObj.id, "songId": songId');
    expect(swift).toContain('self.sendEvent("ended", ["deck": deckObj.id, "songId": songId');
  });

  test("the TypeScript bridge types track-bound events with song identity", () => {
    for (const name of ["TimeEvent", "LoadedEvent", "EndedEvent", "SeekedEvent", "ErrorEvent", "PlayingEvent", "WaitingEvent"]) {
      const declaration = bridge.slice(bridge.indexOf(`interface ${name}`));
      expect(declaration.slice(0, declaration.indexOf("}\n") + 2)).toContain("songId: string");
    }
  });

  test("teardown removes the periodic time observer so stopped decks stop emitting", () => {
    expect(swift).toContain("deck.player.removeTimeObserver(observer)");
    expect(swift).toContain("clearDeckObservers(deck)");
    expect(swift).toContain("self.setupDeckObservers(deckObj)");
  });
});
