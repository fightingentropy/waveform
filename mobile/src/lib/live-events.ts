// Live Events (concerts) for the Spotify-style "Live Events" screen.
//
// This is SAMPLE data for now (artist photos via Deezer's keyless image CDN). To go
// live, point the screen at a real feed — Ticketmaster Discovery API is the natural
// fit (free dev key required), proxied through the worker so the key stays
// server-side. Map each `_embedded.events[i]` → LiveEvent:
//   artists  ← _embedded.attractions[].name (or event.name)
//   venue    ← `${_embedded.venues[0].name}, ${_embedded.venues[0].city.name}`
//   date     ← dates.start.localDate
//   imageUrl ← images[] (pick a ~640w)
//   genre    ← classifications[0].genre.name

export type LiveEvent = {
  id: string;
  artists: string;
  venue: string;
  date: string; // ISO yyyy-mm-dd
  imageUrl: string;
  url?: string;
  genre?: string;
};

export type LiveEventSection = {
  key: string;
  eyebrow: string;
  title: string;
  events: LiveEvent[];
};

// Deezer artist image (keyless, stable CDN). 500x500 is plenty for the cards.
const dz = (hash: string) => `https://cdn-images.dzcdn.net/images/artist/${hash}/500x500-000000-80-0-0.jpg`;

export const LIVE_EVENT_SECTIONS: LiveEventSection[] = [
  {
    key: "popular",
    eyebrow: "What’s trending right now",
    title: "Popular near you",
    events: [
      { id: "bruno", artists: "Bruno Mars, Victoria Monét", venue: "Wembley Stadium, London", date: "2026-07-18", imageUrl: dz("90f0b5b11df4f87ee878f38569b5995b"), genre: "Pop" },
      { id: "weeknd", artists: "The Weeknd, Playboi Carti", venue: "Wembley Stadium, London", date: "2026-08-14", imageUrl: dz("581693b4724a7fcfa754455101e13a44"), genre: "R&B" },
      { id: "badbunny", artists: "Bad Bunny, Chuwi", venue: "Tottenham Hotspur Stadium, London", date: "2026-06-27", imageUrl: dz("044a3f315b041864887a8dd8709e6926"), genre: "Reggaeton" },
      { id: "fred", artists: "Fred again.., Romy", venue: "Finsbury Park, London", date: "2026-07-25", imageUrl: dz("f49a21212bfea7814ecb21096ccb0007"), genre: "Electronic" },
    ],
  },
  {
    key: "upcoming",
    eyebrow: "More concerts near you",
    title: "Coming up",
    events: [
      { id: "harry", artists: "Harry Styles, Shania Twain", venue: "Wembley Stadium, London", date: "2026-06-17", imageUrl: dz("1151dba9b3edc0633adf35b64c21713f"), genre: "Pop" },
      { id: "fatboy", artists: "Fatboy Slim, Eliza Rose, Lizzie", venue: "High Lodge, Thetford Forest", date: "2026-06-19", imageUrl: dz("f6ea7bd64ec1902feff17935fdfea263"), genre: "Electronic" },
      { id: "empire", artists: "Empire Of The Sun, Balu Brigada", venue: "Alexandra Palace, London", date: "2026-06-24", imageUrl: dz("7a91845938492af3644e7152a661ca95"), genre: "Indie" },
      { id: "lorde", artists: "Lorde, Clairo", venue: "O2 Arena, London", date: "2026-07-02", imageUrl: dz("c38f17b73ad22d280c5dfc8a8b3d1865"), genre: "Pop" },
    ],
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Parse a yyyy-mm-dd directly (avoids Date timezone drift) into a calendar badge.
export function formatEventDate(iso: string): { month: string; day: string } {
  const [, month, day] = iso.split("-").map((n) => parseInt(n, 10));
  return { month: MONTHS[(month - 1) % 12] ?? "", day: Number.isFinite(day) ? String(day) : "" };
}
