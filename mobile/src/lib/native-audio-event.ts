export type TrackBoundNativeEvent<Deck extends string = string> = {
  deck: Deck;
  songId?: string;
};

// A/B identifies a reusable player deck, not the item that produced an event.
// Requiring the native item id as well prevents a late end/error/time callback
// from the outgoing queue song being applied to a song the user just selected.
export function isCurrentTrackEvent<Deck extends string>(
  event: TrackBoundNativeEvent<Deck>,
  activeDeck: Deck,
  currentSongId: string | null | undefined,
  deckSongId: string | null | undefined,
): boolean {
  return (
    event.deck === activeDeck &&
    typeof event.songId === "string" &&
    event.songId.length > 0 &&
    event.songId === currentSongId &&
    event.songId === deckSongId
  );
}
