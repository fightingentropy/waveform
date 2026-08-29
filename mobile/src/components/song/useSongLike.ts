import { Alert } from "react-native";
import { useAuth } from "@/lib/auth";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";

// Self-contained like state for a song. The web app prop-drilled liked/canLike/
// onToggleLike from each page; in RN the cards read the likes store directly.
export function useSongLike(song: PlayerSong) {
  const liked = useLikesStore((s) => !!s.likedSongIds[song.id]);
  const pending = useLikesStore((s) => !!s.pending[song.id]);
  const { status } = useAuth();
  const isLocal = song.id.startsWith("browser-local:") || song.id.startsWith("picked-file:");
  const canLike = (status === "authenticated" || isLocal) && !isRadioSong(song) && !isPodcastSong(song);

  const toggle = () => {
    const nextLiked = !liked;
    void useLikesStore.getState().toggleLike(song.id, nextLiked, song).then((result) => {
      if (result.ok) return;
      Alert.alert(
        nextLiked ? "Couldn't add to Liked Songs" : "Couldn't remove from Liked Songs",
        result.error || "Please try again.",
      );
    });
  };

  return { liked, pending, canLike, toggle };
}
