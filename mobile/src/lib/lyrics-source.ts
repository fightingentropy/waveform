export type LyricsSourceResponse = {
  ok: boolean;
  text: () => Promise<string>;
};

export type LyricsSourceReaders = {
  readLocal: (url: string) => Promise<string>;
  fetchRemote: (url: string) => Promise<LyricsSourceResponse>;
};

export function isDeviceLocalLyricsUrl(url: string): boolean {
  return /^file:\/\//i.test(url) || url.startsWith("/");
}

// React Native's fetch implementation does not reliably read file:// URLs.
// Route durable lyrics through expo-file-system and reserve fetch for HTTP(S).
export async function loadLyricsText(
  url: string,
  readers: LyricsSourceReaders,
): Promise<string> {
  if (isDeviceLocalLyricsUrl(url)) return readers.readLocal(url);
  const response = await readers.fetchRemote(url);
  if (!response.ok) throw new Error("No lyrics available");
  return response.text();
}
