export type PlaylistDeletePolicyInput = {
  id: string;
  editable?: boolean;
  deletable?: boolean;
};

// Prefer the server's explicit capability when available. Older cached/API
// payloads only expose `editable`, so retain the established folder-id fallback:
// converted local folders may be renamed and edited, but deleting one could
// imply deleting the owner's source files and is therefore never offered.
export function canDeletePlaylist(playlist: PlaylistDeletePolicyInput): boolean {
  if (typeof playlist.deletable === "boolean") return playlist.deletable;
  return playlist.editable === true && !playlist.id.startsWith("local-folder-");
}
