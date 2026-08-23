export const SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE =
  "The lossless provider needs verification again. Open SpotiFLAC on your Mac, complete its verification, sync the refreshed session to the Mac mini, and retry.";

const SPOTIFLAC_SESSION_PATTERNS = [
  /SpotiFLAC community session is not available/i,
  /SpotiFLAC (?:HMAC|verification) session (?:is )?(?:missing|required|expired|unavailable)/i,
  /lossless provider needs verification again/i,
];

export function isSpotiflacVerificationRequiredMessage(value: unknown): boolean {
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  return SPOTIFLAC_SESSION_PATTERNS.some((pattern) => pattern.test(message));
}

function communityCooldownMessage(message: string): string {
  const match = message.match(
    /(?:the server[^|\n]{0,160}?(?:short break|try again)[^|\n]{0,120}?(?:minute\(s\)|minutes?)[^|\n.]*)/i,
  );
  if (!match) return "";
  const text = match[0].trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/[\s:;,-]+$/, "")}.`;
}

/** Keep provider diagnostics out of the user-facing upload page. */
export function formatSpotifyImportErrorMessage(value: unknown): string {
  const message = (typeof value === "string" ? value : value instanceof Error ? value.message : "").trim();
  if (!message) return "Failed to download this song.";
  if (isSpotiflacVerificationRequiredMessage(message)) return SPOTIFLAC_VERIFICATION_REQUIRED_MESSAGE;

  const cooldown = communityCooldownMessage(message);
  if (cooldown) return cooldown;

  const providerSeparatorCount = message.match(/\s\|\s/g)?.length ?? 0;
  if (message.length > 360 || providerSeparatorCount >= 3 || /No downloadable provider found/i.test(message)) {
    return "No lossless download provider is available right now. Please try again later.";
  }
  return message;
}
