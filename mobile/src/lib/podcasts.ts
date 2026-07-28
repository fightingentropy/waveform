import type { PlayerSong } from "@/types/player";

// Ported from src/lib/podcasts.ts. The web parser uses DOMParser (absent in RN),
// so feed parsing here is regex-based.
export type PodcastShow = {
  id: string;
  title: string;
  author: string;
  subtitle: string;
  description: string;
  feedUrl: string;
  websiteUrl: string;
  imageUrl: string;
  // True for shows the user added by RSS URL. These resolve media directly from
  // the feed (native has no CORS) instead of through the /api/podcast-media proxy,
  // which only knows the built-in PODCAST_SHOWS.
  userAdded?: boolean;
};

export type PodcastEpisode = PlayerSong & {
  source: "podcast";
  podcastId: string;
  podcastTitle: string;
  description: string;
  publishedAt?: string;
};

export const PODCAST_FEED_MAX_BYTES = 4 * 1024 * 1024;
export const PODCAST_FEED_EPISODE_LIMIT = 50;

// Read only the useful prefix of an RSS response. Expo's native fetch exposes a
// streaming body on iOS, so this bounds retained feed data even when a publisher
// serves a multi-thousand-item/17MB document. A partial final item is harmless:
// parsePodcastFeed only accepts complete <item> blocks.
export async function readPodcastFeedPrefix(
  response: Response,
  {
    maxBytes = PODCAST_FEED_MAX_BYTES,
    maxItems = PODCAST_FEED_EPISODE_LIMIT,
  }: { maxBytes?: number; maxItems?: number } = {},
): Promise<string> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive finite number");
  }
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new RangeError("maxItems must be a positive integer");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Podcast feed could not be streamed safely");
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  let itemCount = 0;
  let itemBoundaryCarry = "";
  let shouldCancel = false;

  try {
    while (bytesRead < maxBytes && itemCount < maxItems) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const remaining = maxBytes - bytesRead;
      const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += accepted.byteLength;

      const decoded = decoder.decode(accepted, { stream: true });
      parts.push(decoded);

      // The parser recognizes the same conventional RSS closing tag. Retaining
      // six trailing characters catches a tag split across stream chunks.
      const searchable = `${itemBoundaryCarry}${decoded}`.toLowerCase();
      let cursor = 0;
      while (itemCount < maxItems) {
        const next = searchable.indexOf("</item>", cursor);
        if (next === -1) break;
        itemCount += 1;
        cursor = next + 7;
      }
      itemBoundaryCarry = searchable.slice(-6);

      if (value.byteLength > accepted.byteLength || bytesRead >= maxBytes || itemCount >= maxItems) {
        shouldCancel = true;
        break;
      }
    }

    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    if (shouldCancel) {
      await reader.cancel("Podcast feed prefix complete").catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export const PODCAST_SHOWS: PodcastShow[] = [
  {
    id: "huberman-lab",
    title: "Huberman Lab",
    author: "Andrew Huberman, Ph.D.",
    subtitle: "Neuroscience and science-based tools",
    description: "Neuroscience, health, and performance conversations with Andrew Huberman and guests.",
    feedUrl: "https://feeds.megaphone.fm/hubermanlab",
    websiteUrl: "https://www.hubermanlab.com/podcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/042e6144-725e-11ec-a75d-c38f702aecad/image/ee4f0b7b466ca35620792970d9bce2d2.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
  },
  {
    id: "modern-wisdom",
    title: "Modern Wisdom",
    author: "Chris Williamson",
    subtitle: "Lessons from the greatest thinkers on the planet",
    description: "Life lessons, ideas, and tactics for navigating modern life with Chris Williamson and guests.",
    feedUrl: "https://feeds.megaphone.fm/SIXMSB5088139739",
    websiteUrl: "https://chriswillx.com/podcast/",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/a62f84c0-f8b6-11ed-a4fc-fb9e7841d45b/image/76ed638554a4be965517200d1cd5f30d.jpg?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
  },
  {
    id: "flagrant",
    title: "Flagrant",
    author: "Andrew Schulz",
    subtitle: "Unfiltered comedy and culture",
    description: "Unfiltered comedy, culture, and unruly conversations with Andrew Schulz and guests.",
    feedUrl: "https://feeds.megaphone.fm/APPI6857213837",
    websiteUrl: "https://soundcloud.com/flagrantpodcast",
    imageUrl:
      "https://megaphone.imgix.net/podcasts/0adac72a-8012-11ef-9b16-bffe28b27ef7/image/84f5c3e24f7864f2fd9f7fc858aa2889.png?ixlib=rails-4.3.1&max-w=3000&max-h=3000&fit=crop&auto=format,compress",
  },
  {
    id: "all-in",
    title: "All-In",
    author: "Chamath, Jason, Sacks & Friedberg",
    subtitle: "Markets, tech, politics, and poker",
    description: "Industry veterans cover all things economic, tech, political, social, and poker.",
    feedUrl: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml",
    websiteUrl: "https://allin.com/",
    imageUrl: "https://static.libsyn.com/p/assets/a/9/c/b/a9cb4d1dadb1ea21/all-in_logo.png",
  },
];

export function podcastMediaProxyUrl(showId: string, mediaUrl: string): string {
  return `/api/podcast-media/${encodeURIComponent(showId)}?url=${encodeURIComponent(mediaUrl)}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function attr(block: string, tagName: string, name: string): string {
  const m = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : "";
}

function parseDuration(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const s = Number(trimmed);
    return Number.isFinite(s) && s > 0 ? s : undefined;
  }
  const parts = trimmed.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return undefined;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : undefined;
}

function stableId(showId: string, seed: string): string {
  const key = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return `podcast:${showId}:${key || "episode"}`;
}

// Built-in shows relay media through the SSRF-guarded /api/podcast-media proxy
// (the Worker validates every URL against the known feed). User-added shows have
// no server-side feed entry, so they reference the raw feed URLs directly — fine
// on native, which has no CORS and streams https audio via AVPlayer.
function resolveMediaUrl(show: PodcastShow, url: string): string {
  return show.userAdded ? url : podcastMediaProxyUrl(show.id, url);
}

// Regex feed parse (no DOMParser in RN). Returns episodes with proxied media URLs.
//
// Streams items with a stateful exec() loop and stops at `limit`, so it only scans
// the prefix of the document holding the first `limit` items — NOT the whole feed.
// This matters: big shows ship 17MB / 2,900-item feeds, and `.match(/…/g)` over all
// of that (plus splitting on every "<item") hard-hangs Hermes, which has no regex
// JIT. Bounding the scan keeps a giant feed as cheap as a small one.
export function parsePodcastFeed(xmlText: string, show: PodcastShow, limit = 50): PodcastEpisode[] {
  const firstItem = xmlText.indexOf("<item");
  const channelPart = firstItem === -1 ? xmlText : xmlText.slice(0, firstItem);
  const channelImage = attr(channelPart, "itunes:image", "href") || show.imageUrl;
  const episodes: PodcastEpisode[] = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let match: RegExpExecArray | null;
  while (episodes.length < limit && (match = itemRe.exec(xmlText)) !== null) {
    const block = match[0];
    const audioUrl = attr(block, "enclosure", "url");
    if (!audioUrl) continue;
    const title = tag(block, "title") || "Untitled episode";
    const guid = tag(block, "guid");
    const itemImage = attr(block, "itunes:image", "href") || channelImage;
    episodes.push({
      id: stableId(show.id, guid || audioUrl || title),
      title,
      artist: show.title,
      album: "Podcasts",
      imageUrl: resolveMediaUrl(show, itemImage),
      audioUrl: resolveMediaUrl(show, audioUrl),
      duration: parseDuration(tag(block, "itunes:duration")),
      source: "podcast",
      podcastId: show.id,
      podcastTitle: show.title,
      description: tag(block, "description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      publishedAt: tag(block, "pubDate") || undefined,
    });
  }
  return episodes;
}

// Stable, URL-safe id for a user feed (djb2 hash, base36). Same URL → same id, so
// re-adding a feed updates the existing show instead of duplicating it.
function hashFeedUrl(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = (((h << 5) + h) ^ value.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

export function userPodcastId(feedUrl: string): string {
  return `user-${hashFeedUrl(feedUrl.trim().toLowerCase()).toString(36)}`;
}

// Pull the channel-level <image>/<url> when there's no <itunes:image href>.
function rssChannelImage(channel: string): string {
  const block = channel.match(/<image\b[^>]*>([\s\S]*?)<\/image>/i)?.[1] ?? "";
  return tag(block, "url");
}

// Build a PodcastShow from a fetched feed so a user feed displays like the built-in
// shows. Returns null when the document has no usable <channel><title>.
export function buildUserPodcastShow(feedUrl: string, xmlText: string): PodcastShow | null {
  const channel = xmlText.split(/<item\b/i)[0] ?? xmlText;
  const title = tag(channel, "title");
  if (!title) return null;
  const description = (tag(channel, "description") || tag(channel, "itunes:summary"))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const author = tag(channel, "itunes:author") || tag(channel, "managingEditor") || "Podcast";
  const subtitle =
    tag(channel, "itunes:subtitle") ||
    (description.length > 80 ? `${description.slice(0, 77).trimEnd()}…` : description) ||
    author;
  const url = feedUrl.trim();
  return {
    id: userPodcastId(url),
    title,
    author,
    subtitle,
    description,
    feedUrl: url,
    websiteUrl: tag(channel, "link"),
    imageUrl: attr(channel, "itunes:image", "href") || rssChannelImage(channel),
    userAdded: true,
  };
}
