import { useEffect, useRef } from "react";
import { initAudio, restorePlaybackState, startSleepTimerWatchdog } from "@/audio/engine";
import { useAuth } from "@/lib/auth";
import { loadIdMap } from "@/lib/canonical-ids";

// Boots the audio engine once and restores cross-device playback state after auth
// settles. Rendered inside AuthProvider in the root layout.
export function AudioBootstrap() {
  const { user, status } = useAuth();

  useEffect(() => {
    void initAudio();
    startSleepTimerWatchdog();
  }, []);

  // Restore exactly once per signed-in session. We pass the resolved account scope
  // (matching AuthProvider's `user?.id ?? status`) because this child effect runs
  // before AuthProvider's scope effect — without it the restore reads a stale
  // "anonymous" scope and rejects this device's own saved snapshot. The ref guards
  // against a later dep change re-running restore and clobbering live playback;
  // it resets on sign-out so a re-login restores the next account's state.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (status === "unauthenticated") {
      restoredRef.current = false;
      return;
    }
    if (status !== "authenticated" || restoredRef.current) return;
    restoredRef.current = true;
    void restorePlaybackState(user?.id ?? status);
  }, [status, user?.id]);

  // Load the canonical id-map so like-state goes canonical-aware (like-once). It
  // re-expands the in-flight liked set the moment it lands and is empty while the
  // server's canonical-likes flag is off, so it's inert until that flips.
  useEffect(() => {
    if (status !== "authenticated") return;
    void loadIdMap(user?.id ?? status);
  }, [status, user?.id]);

  return null;
}
