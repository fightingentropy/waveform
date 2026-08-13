"use client";

import { PlayerBarChrome } from "@/components/PlayerBarChrome";
import { usePlaybackEngine } from "@/lib/use-playback-engine";

function PlayerBar(): React.ReactElement {
  const { audioElements, chrome } = usePlaybackEngine();

  // Always render the two <audio> nodes first, at a stable tree position, in
  // both the null and non-null states. If they were reconciled away on a
  // null<->song transition React would destroy+recreate them, causing double
  // playback and breaking the iOS user-gesture chain.
  return (
    <>
      {audioElements}
      {chrome ? <PlayerBarChrome {...chrome} /> : null}
    </>
  );
}

export { PlayerBar };
export default PlayerBar;
