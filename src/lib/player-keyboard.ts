export type PlaybackKeyTargetInfo = {
  isContentEditable: boolean;
  tagName: string;
  inputType: string | null;
};

export function playbackKeyTargetInfo(target: EventTarget | null): PlaybackKeyTargetInfo | null {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return null;
  return {
    isContentEditable: target.isContentEditable,
    tagName: target.tagName.toUpperCase(),
    inputType:
      typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement
        ? target.type.toLowerCase()
        : null,
  };
}

export function isSpaceKey(event: Pick<KeyboardEvent, "code" | "key">): boolean {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

export function shouldPreservePlaybackShortcutTarget(info: PlaybackKeyTargetInfo | null): boolean {
  if (!info) return false;
  if (info.isContentEditable) return true;
  if (info.tagName === "TEXTAREA" || info.tagName === "SELECT") return true;
  return info.tagName === "INPUT" && info.inputType !== "range";
}

export function shouldPreserveEditableShortcutTarget(info: PlaybackKeyTargetInfo | null): boolean {
  if (!info) return false;
  return (
    info.isContentEditable ||
    info.tagName === "INPUT" ||
    info.tagName === "TEXTAREA" ||
    info.tagName === "SELECT"
  );
}
