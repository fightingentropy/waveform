import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import { Rss } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { ErrorText } from "@/components/ui/States";
import { buildUserPodcastShow, readPodcastFeedPrefix } from "@/lib/podcasts";
import { useUserPodcastsStore } from "@/store/user-podcasts";
import { colors } from "@/theme";

const inputStyle = { color: colors.foreground, height: 48, fontSize: 16, paddingHorizontal: 14, backgroundColor: "#1f1f1f", borderRadius: 8 } as const;

type Status = { kind: "idle" | "busy" | "error"; message?: string };

// Add a scheme so "example.com/feed" works; bare input → https://.
function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Native has no CORS, so the app fetches the feed directly. Abort after 15s so a
// dead host doesn't hang the spinner forever.
async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await expoFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`Feed returned ${res.status}`);
    // Adding a show only needs channel metadata; one complete item is enough to
    // terminate the stream while still validating a conventional RSS feed.
    return await readPodcastFeedPrefix(res, { maxItems: 1 });
  } finally {
    clearTimeout(timer);
  }
}

export default function AddPodcastScreen() {
  const router = useRouter();
  const addShow = useUserPodcastsStore((s) => s.addShow);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const onAdd = async () => {
    const feedUrl = normalizeFeedUrl(url);
    if (!feedUrl) return;
    setStatus({ kind: "busy" });
    try {
      const xml = await fetchFeedXml(feedUrl);
      const show = buildUserPodcastShow(feedUrl, xml);
      if (!show) throw new Error("That doesn't look like a podcast RSS feed.");
      addShow(show);
      router.replace(`/podcasts/${show.id}`);
    } catch (e) {
      const message =
        e instanceof Error && e.name === "AbortError"
          ? "Timed out fetching the feed. Check the URL and try again."
          : e instanceof Error
            ? e.message
            : "Couldn't add that feed.";
      setStatus({ kind: "error", message });
    }
  };

  const busy = status.kind === "busy";
  const disabled = busy || !url.trim();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Add a podcast",
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
          headerShadowVisible: false,
        }}
      />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: CONTENT_BOTTOM_INSET,
          gap: 12,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-lg" style={{ backgroundColor: "#1f1f1f" }}>
            <Rss size={22} color={colors.emerald} />
          </View>
          <Text className="flex-1 text-[13px] leading-5" style={{ color: colors.muted }}>
            Paste a podcast RSS feed URL. We'll fetch its details and add it alongside your other shows.
          </Text>
        </View>

        <TextInput
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            if (status.kind === "error") setStatus({ kind: "idle" });
          }}
          onSubmitEditing={onAdd}
          placeholder="https://feeds.example.com/podcast.xml"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          style={inputStyle}
        />

        <PressableScale
          onPress={onAdd}
          disabled={disabled}
          className="items-center rounded-full py-3"
          style={{ backgroundColor: colors.green, opacity: disabled ? 0.6 : 1 }}
        >
          <Text className="font-bold text-black">{busy ? "Adding…" : "Add podcast"}</Text>
        </PressableScale>

        {status.kind === "error" && status.message ? <ErrorText>{status.message}</ErrorText> : null}
      </ScrollView>
    </View>
  );
}
