import "@/lib/logbox";
import "react-native-url-polyfill/auto";
import "@/audio/register";
import "../../global.css";

import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DarkTheme, Redirect, Stack, ThemeProvider, useSegments } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AudioBootstrap } from "@/components/AudioBootstrap";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { PlayerSheets } from "@/components/player/PlayerSheets";
import { TabBar } from "@/components/nav/TabBar";
import { ProfileMenu } from "@/components/profile/ProfileMenu";
import { initOfflineSync } from "@/store/offline";
import { initImportQueue } from "@/lib/import-queue";
import { colors } from "@/theme";

void SplashScreen.preventAutoHideAsync();

const headerOptions = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerShadowVisible: false,
  // Native-stack soft edge treatments on iOS 26/27; older platforms ignore it.
  // This gives pushed scrolling screens a system-material transition into chrome.
  scrollEdgeEffects: { top: "soft", bottom: "soft" },
  // Show only the back chevron — not the previous route's title (which was the
  // expo-router group name "(tabs)").
  headerBackButtonDisplayMode: "minimal",
} as const;

const spotifyNavigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.green,
    background: colors.background,
    card: colors.background,
    text: colors.foreground,
    border: "transparent",
    notification: colors.green,
  },
};

function AuthenticatedApp() {
  const { status } = useAuth();
  const segments = useSegments();
  const firstSegment = segments[0] ?? "";
  const isPublicAuthRoute = firstSegment === "signin";

  if (status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.green} />
      </View>
    );
  }
  if (status === "unauthenticated" && !isPublicAuthRoute) return <Redirect href="/signin" />;
  if (status === "authenticated" && isPublicAuthRoute) return <Redirect href="/(tabs)" />;

  return (
    <ThemeProvider value={spotifyNavigationTheme}>
      <AudioBootstrap />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          // iOS 27 removed UIApplication-level status-bar styling. Let the
          // native stack own appearance through its view controllers instead.
          statusBarStyle: "light",
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="signin" options={{ presentation: "modal" }} />
        <Stack.Screen
          name="liked"
          options={{
            ...headerOptions,
            title: "",
            headerTransparent: true,
            headerStyle: { backgroundColor: "transparent" },
            headerTintColor: "#fff",
          }}
        />
        <Stack.Screen name="downloads" options={{ ...headerOptions, title: "Downloads" }} />
        <Stack.Screen name="radio" options={{ ...headerOptions, title: "Radio Stations" }} />
        <Stack.Screen name="podcasts" options={{ ...headerOptions, title: "Podcasts" }} />
        <Stack.Screen name="events" options={{ headerShown: false }} />
        <Stack.Screen name="upload" options={{ ...headerOptions, title: "Upload" }} />
        <Stack.Screen name="settings" options={{ ...headerOptions, title: "Settings" }} />
        <Stack.Screen name="settings/account" options={{ ...headerOptions, title: "Account" }} />
        <Stack.Screen name="settings/playback" options={{ ...headerOptions, title: "Playback" }} />
        <Stack.Screen name="settings/lyrics" options={{ ...headerOptions, title: "Lyrics" }} />
        <Stack.Screen name="settings/storage" options={{ ...headerOptions, title: "Data-saving and offline" }} />
        <Stack.Screen name="settings/about" options={{ ...headerOptions, title: "About" }} />
        <Stack.Screen name="profile" options={{ ...headerOptions, title: "Profile" }} />
        <Stack.Screen name="listening-stats" options={{ ...headerOptions, title: "Listening stats" }} />
        <Stack.Screen
          name="playlist/[id]"
          options={{
            ...headerOptions,
            title: "",
            headerTransparent: true,
            headerStyle: { backgroundColor: "transparent" },
            headerTintColor: "#fff",
          }}
        />
        <Stack.Screen
          name="search/playlist/[source]/[id]"
          options={{
            ...headerOptions,
            title: "",
            headerTransparent: true,
            headerStyle: { backgroundColor: "transparent" },
            headerTintColor: "#fff",
          }}
        />
        <Stack.Screen
          name="search/artist/[source]/[id]"
          options={{
            ...headerOptions,
            title: "",
            headerTransparent: true,
            headerStyle: { backgroundColor: "transparent" },
            headerTintColor: "#fff",
          }}
        />
      </Stack>
      <TabBar />
      <MiniPlayer />
      <PlayerSheets />
      <ProfileMenu />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
    void SplashScreen.hideAsync();
  }, []);

  // Replay the offline mutation outbox (likes/edits queued while offline) when the
  // app returns to the foreground; returns an AppState unsubscribe for cleanup.
  useEffect(() => initOfflineSync(), []);
  useEffect(() => initImportQueue(), []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
