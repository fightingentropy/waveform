const LUMA_CAP = 85;

export function toBackgroundTint(hex: string): string {
  const value = hex.replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((character) => character + character).join("") : value;
  let red = parseInt(normalized.slice(0, 2), 16);
  let green = parseInt(normalized.slice(2, 4), 16);
  let blue = parseInt(normalized.slice(4, 6), 16);
  const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
  if (luma > LUMA_CAP) {
    const scale = LUMA_CAP / luma;
    red = Math.round(red * scale);
    green = Math.round(green * scale);
    blue = Math.round(blue * scale);
  }
  const channel = (channelValue: number) => channelValue.toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1 ? [chroma, secondary, 0]
      : section < 2 ? [secondary, chroma, 0]
        : section < 3 ? [0, chroma, secondary]
          : section < 4 ? [0, secondary, chroma]
            : section < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  const byte = (channel: number) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0");
  return `#${byte(red)}${byte(green)}${byte(blue)}`;
}

export function tintFromArtworkUri(uri: string): string {
  let hash = 2166136261;
  for (let index = 0; index < uri.length; index += 1) {
    hash ^= uri.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return toBackgroundTint(hslToHex((hash >>> 0) % 360, 0.52, 0.28));
}
