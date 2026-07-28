import { useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Camera, ChevronRight, LineChart, LogOut, User } from "lucide-react-native";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

export default function ProfileScreen() {
  const router = useRouter();
  const { user, status, signOut, updateProfileImage } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "unauthenticated") {
    return (
      <Screen topInset={false}>
        <SignedOutPrompt message="Sign in to view your profile." />
      </Screen>
    );
  }

  const pickImage = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setBusy(true);
    try {
      await updateProfileImage({
        uri: asset.uri,
        name: asset.fileName ?? "avatar.jpg",
        type: asset.mimeType ?? "image/jpeg",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update profile image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen topInset={false}>
      <View className="flex-1 px-6 pt-8" style={{ backgroundColor: colors.background }}>
        <View className="items-center">
          <PressableScale onPress={pickImage} disabled={busy}>
            <View className="h-28 w-28 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
              {user?.image ? (
                <CoverImage src={user.image} style={{ width: "100%", height: "100%" }} />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <User size={48} color={colors.iconIdle} />
                </View>
              )}
              <View className="absolute bottom-1 right-1 h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: colors.emerald }}>
                <Camera size={16} color="#050505" />
              </View>
            </View>
          </PressableScale>
          <Text className="mt-4 text-2xl font-bold" style={{ color: colors.foreground }}>
            {user?.name || "Listener"}
          </Text>
          <Text className="mt-1 text-sm" style={{ color: colors.muted }}>
            {user?.email}
          </Text>
          {error ? <View className="mt-3"><ErrorText>{error}</ErrorText></View> : null}
        </View>

        <View className="mt-10">
          <PressableScale scaleTo={1} onPress={() => router.push("/listening-stats")} className="flex-row items-center justify-between py-4">
            <View className="flex-row items-center gap-3">
              <LineChart size={20} color={colors.foreground} />
              <Text className="text-base" style={{ color: colors.foreground }}>Listening stats</Text>
            </View>
            <ChevronRight size={20} color={colors.muted} />
          </PressableScale>
          <PressableScale scaleTo={1} onPress={() => router.push("/settings")} className="flex-row items-center justify-between py-4">
            <Text className="text-base" style={{ color: colors.foreground }}>Settings</Text>
            <ChevronRight size={20} color={colors.muted} />
          </PressableScale>
          <PressableScale
            scaleTo={1}
            onPress={async () => {
              await signOut();
              router.replace("/(tabs)");
            }}
            className="flex-row items-center gap-3 py-4"
          >
            <LogOut size={20} color="#f87171" />
            <Text className="text-base" style={{ color: "#f87171" }}>Sign out</Text>
          </PressableScale>
        </View>
      </View>
    </Screen>
  );
}
