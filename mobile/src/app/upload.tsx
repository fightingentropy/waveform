import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { FileAudio, Image as ImageIcon, Link2 } from "lucide-react-native";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { apiFetch, apiUrl } from "@/lib/http";
import { invalidateLibraryApiCache } from "@/lib/api";
import { getOfflineAccountScope } from "@/store/offline";
import { type BatchInfo, isBatchSpotifyUrl, resolveSpotifyBatch } from "@/lib/spotify-batch-client";
import {
  cancelImportQueue,
  enqueueImportBatch,
  subscribeImportQueue,
  type ImportQueueState,
} from "@/lib/import-queue";
import { colors } from "@/theme";

type Mode = "link" | "file";
type Status = { kind: "idle" | "busy" | "ok" | "error"; message?: string };
type BatchProgress = { current: number; total: number; currentTrack: string; succeeded: number; skipped: number; failed: number };

const inputStyle = { color: colors.foreground, height: 48, fontSize: 16, paddingHorizontal: 14, backgroundColor: "#1f1f1f", borderRadius: 8 } as const;

type ImportStage = "resolving" | "downloading" | "saving";
type SingleProgress = { stage: ImportStage; received: number; total: number };
type ImportOutcome = { kind: "done" } | { kind: "duplicate" } | { kind: "error"; message: string };

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function importStageLabel(p: SingleProgress): string {
  if (p.stage === "resolving") return "Resolving lossless source…";
  if (p.stage === "saving") return "Saving to your library…";
  return "Downloading lossless audio…";
}

// True download % for the label; bar width is capped separately so it only moves forward.
function importDownloadPercent(p: SingleProgress): number {
  if (p.total <= 0) return 0;
  return Math.min(100, Math.round((p.received / p.total) * 100));
}

function importBarPercent(p: SingleProgress): number {
  if (p.stage === "resolving") return 8;
  if (p.stage === "saving") return 98;
  if (p.total > 0) return Math.min(96, Math.max(2, Math.round((p.received / p.total) * 100)));
  return p.received > 0 ? 55 : 12;
}

function importProgressRight(p: SingleProgress): string {
  if (p.stage === "downloading" && p.total > 0) {
    return `${importDownloadPercent(p)}% · ${formatMb(p.received)} / ${formatMb(p.total)} MB`;
  }
  if (p.stage === "downloading" && p.received > 0) return `${formatMb(p.received)} MB`;
  return "";
}

// Single-track import with real progress. RN's fetch can't stream a response body,
// so we use XMLHttpRequest — it shares the native cookie jar (auth) and fires
// onprogress with an accumulating responseText we parse as NDJSON. Falls back to
// the plain JSON outcome if the server didn't stream (older worker / non-mini).
function runSpotifyImportWithProgress(
  body: string,
  onProgress: (p: SingleProgress) => void,
): Promise<ImportOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/api/songs"));
    xhr.withCredentials = true;
    // Force text handling so RN decodes responseText incrementally on each
    // onprogress (some content-types are otherwise buffered as a blob).
    xhr.responseType = "text";
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("x-progress-stream", "1");

    let parsedLen = 0;
    let outcome: ImportOutcome = {
      kind: "error",
      message: "Connection interrupted before the import finished — check your library before retrying.",
    };

    const handleLine = (line: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const stage = typeof event.stage === "string" ? event.stage : "";
      if (stage === "resolving") onProgress({ stage: "resolving", received: 0, total: 0 });
      else if (stage === "downloading")
        onProgress({ stage: "downloading", received: Number(event.received) || 0, total: Number(event.total) || 0 });
      else if (stage === "saving") onProgress({ stage: "saving", received: 0, total: 0 });
      else if (stage === "done") outcome = { kind: "done" };
      else if (stage === "duplicate") outcome = { kind: "duplicate" };
      else if (stage === "error")
        outcome = { kind: "error", message: typeof event.error === "string" ? event.error : "Import failed" };
    };

    const parse = (text: string, isFinal: boolean) => {
      for (;;) {
        const nl = text.indexOf("\n", parsedLen);
        if (nl < 0) break;
        const line = text.slice(parsedLen, nl).trim();
        parsedLen = nl + 1;
        if (line) handleLine(line);
      }
      if (isFinal) {
        const tail = text.slice(parsedLen).trim();
        if (tail) handleLine(tail);
        parsedLen = text.length;
      }
    };

    xhr.onprogress = () => parse(xhr.responseText || "", false);
    xhr.onload = () => {
      parse(xhr.responseText || "", true);
      const contentType = (xhr.getResponseHeader("content-type") || "").toLowerCase();
      if (!contentType.includes("application/x-ndjson")) {
        // Server returned a one-shot JSON response (no streaming) — map its status.
        if (xhr.status === 409) outcome = { kind: "duplicate" };
        else if (xhr.status >= 200 && xhr.status < 300) outcome = { kind: "done" };
        else {
          let message = `Import failed (${xhr.status})`;
          try {
            const data = JSON.parse(xhr.responseText || "{}") as { error?: string };
            if (data.error) message = data.error;
          } catch {}
          outcome = { kind: "error", message };
        }
      }
      resolve(outcome);
    };
    xhr.onerror = () => resolve({ kind: "error", message: "Network error during import" });
    xhr.send(body);
  });
}

export default function UploadScreen() {
  const { status: authStatus } = useAuth();
  const [mode, setMode] = useState<Mode>("link");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // link mode
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [singleProgress, setSingleProgress] = useState<SingleProgress | null>(null);
  // batch mode (album / playlist / Liked Songs)
  const [batchInfo, setBatchInfo] = useState<BatchInfo | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchFailures, setBatchFailures] = useState<string[]>([]);
  const [showFailures, setShowFailures] = useState(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  // file mode
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [audio, setAudio] = useState<{ uri: string; name: string; mimeType?: string } | null>(null);
  const [cover, setCover] = useState<{ uri: string; name: string; type: string } | null>(null);

  if (authStatus === "unauthenticated") {
    return (
      <Screen topInset={false}>
        <SignedOutPrompt message="Sign in to upload music." />
      </Screen>
    );
  }

  // Single-track import. The backend's /api/songs import requires title/artist,
  // so we resolve the track's metadata first (this also yields the cover art),
  // then stream the download with real progress.
  const importSpotify = async () => {
    const url = spotifyUrl.trim();
    if (!url) return;
    setStatus({ kind: "busy", message: "Importing…" });
    setSingleProgress({ stage: "resolving", received: 0, total: 0 });
    try {
      const metaRes = await apiFetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fetch", spotifyUrl: url, region: "US" }),
      });
      const metaData = (await metaRes.json().catch(() => ({}))) as { track?: BatchTrack & { durationMs?: number }; error?: string };
      if (!metaRes.ok || !metaData.track) {
        throw new Error(metaData.error || "Could not resolve this track on Spotify");
      }
      const track = metaData.track;
      const outcome = await runSpotifyImportWithProgress(
        JSON.stringify({
          mode: "spotify",
          spotifyUrl: url,
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationMs: String(track.durationMs || ""),
          imageUrl: track.imageUrl,
          qualityProfile: "max",
          outputFormat: "flac",
          region: "US",
          replaceExisting: false,
        }),
        setSingleProgress,
      );
      setSingleProgress(null);
      if (outcome.kind === "duplicate") {
        setStatus({ kind: "error", message: "This track is already in your library." });
        return;
      }
      if (outcome.kind === "error") {
        setStatus({ kind: "error", message: outcome.message });
        return;
      }
      invalidateLibraryApiCache(getOfflineAccountScope());
      setSpotifyUrl("");
      setStatus({ kind: "ok", message: "Added to your library." });
    } catch (e) {
      setSingleProgress(null);
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Import failed" });
    }
  };

  // "Fetch" entry point: album/playlist/collection URLs resolve to a batch card;
  // everything else falls through to the single-track import.
  const fetchSpotify = async () => {
    const url = spotifyUrl.trim();
    if (!url) return;
    setBatchInfo(null);
    setBatchProgress(null);
    setBatchFailures([]);
    setShowFailures(false);
    setSingleProgress(null);
    if (!isBatchSpotifyUrl(url)) {
      await importSpotify();
      return;
    }
    setStatus({ kind: "busy", message: "Fetching tracks…" });
    try {
      const info = await resolveSpotifyBatch(url);
      setBatchInfo(info);
      setStatus({ kind: "ok", message: `Found ${info.trackCount} tracks. Tap Download to start.` });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Failed to fetch batch info" });
    }
  };

  const cancelBatchDownload = () => {
    batchAbortRef.current?.abort();
    cancelImportQueue();
  };

  // Enqueue the batch into a durable import pump so downloads continue after
  // leaving this screen or backgrounding the app (as long as JS stays alive).
  const downloadBatch = async () => {
    if (!batchInfo) return;
    setBatchFailures([]);
    setShowFailures(false);
    setStatus({ kind: "busy", message: "Downloading in background…" });
    const state = enqueueImportBatch(batchInfo.tracks);
    setBatchProgress({
      current: state.cursor,
      total: state.items.length,
      currentTrack: state.items[state.cursor]
        ? `${state.items[state.cursor]!.artist} - ${state.items[state.cursor]!.title}`
        : "",
      succeeded: state.succeeded,
      skipped: state.skipped,
      failed: state.failed,
    });
  };

  useEffect(() => {
    return subscribeImportQueue((state: ImportQueueState | null) => {
      if (!state) return;
      const current = state.items[Math.min(state.cursor, Math.max(0, state.items.length - 1))];
      setBatchProgress({
        current: Math.min(state.cursor + (state.running ? 1 : 0), state.items.length),
        total: state.items.length,
        currentTrack: current ? `${current.artist} - ${current.title}` : "",
        succeeded: state.succeeded,
        skipped: state.skipped,
        failed: state.failed,
      });
      setBatchFailures(state.failures);
      if (state.running) {
        setStatus({ kind: "busy", message: "Downloading in background…" });
      } else if (state.cursor >= state.items.length && state.items.length > 0) {
        const summary = `${state.succeeded} downloaded · ${state.skipped} skipped · ${state.failed} failed`;
        if (state.failed > 0 && state.succeeded === 0) setStatus({ kind: "error", message: summary });
        else setStatus({ kind: "ok", message: `Done — ${summary}` });
      }
    });
  }, []);

  const pickAudio = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setAudio({ uri: a.uri, name: a.name, mimeType: a.mimeType });
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ""));
  };

  const pickCover = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setCover({ uri: a.uri, name: a.fileName ?? "cover.jpg", type: a.mimeType ?? "image/jpeg" });
  };

  const uploadFile = async () => {
    if (!audio || !title.trim() || !artist.trim()) {
      setStatus({ kind: "error", message: "Pick an audio file and enter title + artist." });
      return;
    }
    setStatus({ kind: "busy", message: "Uploading…" });
    try {
      const form = new FormData();
      form.append("audio", { uri: audio.uri, name: audio.name, type: audio.mimeType ?? "audio/mpeg" } as unknown as Blob);
      form.append("title", title.trim());
      form.append("artist", artist.trim());
      if (cover) form.append("image", { uri: cover.uri, name: cover.name, type: cover.type } as unknown as Blob);
      const res = await apiFetch("/api/songs", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      invalidateLibraryApiCache(getOfflineAccountScope());
      setAudio(null);
      setCover(null);
      setTitle("");
      setArtist("");
      setStatus({ kind: "ok", message: "Uploaded to your library." });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Upload failed" });
    }
  };

  return (
    <Screen topInset={false}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* mode toggle */}
        <View className="flex-row gap-2">
          {(["link", "file"] as Mode[]).map((m) => (
            <PressableScale
              key={m}
              scaleTo={1}
              onPress={() => {
                setMode(m);
                setStatus({ kind: "idle" });
              }}
              className="flex-1 flex-row items-center justify-center gap-2 rounded-full py-2.5"
              style={{ backgroundColor: mode === m ? colors.emerald : "#1f1f1f" }}
            >
              {m === "link" ? <Link2 size={18} color={mode === m ? "#fff" : colors.muted} /> : <FileAudio size={18} color={mode === m ? "#fff" : colors.muted} />}
              <Text className="font-semibold" style={{ color: mode === m ? "#fff" : colors.muted }}>
                {m === "link" ? "Spotify link" : "File"}
              </Text>
            </PressableScale>
          ))}
        </View>

        {mode === "link" ? (
          <View style={{ gap: 12 }}>
            <TextInput
              value={spotifyUrl}
              onChangeText={(v) => {
                setSpotifyUrl(v);
                if (batchInfo) setBatchInfo(null);
              }}
              placeholder="Track, album, playlist, or Liked Songs URL"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            <PressableScale onPress={fetchSpotify} disabled={status.kind === "busy" || !spotifyUrl.trim()} className="items-center rounded-full py-3" style={{ backgroundColor: colors.green, opacity: status.kind === "busy" || !spotifyUrl.trim() ? 0.6 : 1 }}>
              <Text className="font-bold text-black">{status.kind === "busy" ? (batchInfo ? "Downloading…" : "Working…") : isBatchSpotifyUrl(spotifyUrl.trim()) ? "Fetch tracks" : "Add to library"}</Text>
            </PressableScale>

            {singleProgress && !batchInfo ? (
              <View className="gap-2">
                <View className="flex-row items-center justify-between gap-3">
                  <Text numberOfLines={1} className="flex-1 text-sm" style={{ color: colors.muted }}>
                    {importStageLabel(singleProgress)}
                  </Text>
                  <Text className="text-sm" style={{ color: colors.muted, fontVariant: ["tabular-nums"] }}>
                    {importProgressRight(singleProgress)}
                  </Text>
                </View>
                <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
                  <View className="h-full rounded-full" style={{ backgroundColor: colors.emerald, width: `${importBarPercent(singleProgress)}%` }} />
                </View>
              </View>
            ) : null}

            {batchInfo ? (
              <View className="gap-4 rounded-2xl p-4" style={{ backgroundColor: "#1f1f1f" }}>
                <View className="gap-1">
                  <Text className="text-lg font-bold" numberOfLines={2} style={{ color: colors.foreground }}>{batchInfo.title}</Text>
                  <Text className="text-sm" style={{ color: colors.muted }}>
                    <Text className="capitalize">{batchInfo.type}</Text>
                    {batchInfo.artist ? ` · ${batchInfo.artist}` : ""}
                    {` · ${batchInfo.trackCount} track${batchInfo.trackCount === 1 ? "" : "s"}`}
                  </Text>
                </View>

                <View className="flex-row gap-2">
                  <PressableScale
                    onPress={downloadBatch}
                    disabled={status.kind === "busy"}
                    className="flex-1 items-center rounded-full py-3"
                    style={{ backgroundColor: colors.green, opacity: status.kind === "busy" ? 0.6 : 1 }}
                  >
                    <Text className="font-bold text-black">{status.kind === "busy" ? "Downloading…" : `Download ${batchInfo.trackCount} track${batchInfo.trackCount === 1 ? "" : "s"}`}</Text>
                  </PressableScale>
                  {status.kind === "busy" && batchProgress ? (
                    <PressableScale onPress={cancelBatchDownload} className="items-center justify-center rounded-full px-5 py-3" style={{ backgroundColor: "#333" }}>
                      <Text className="font-semibold" style={{ color: colors.foreground }}>Cancel</Text>
                    </PressableScale>
                  ) : null}
                </View>

                {batchProgress ? (
                  <View className="gap-2">
                    <View className="flex-row items-center justify-between gap-3">
                      <Text numberOfLines={1} className="flex-1 text-sm" style={{ color: colors.muted }}>
                        {batchProgress.currentTrack || "Starting…"}
                      </Text>
                      <Text className="text-sm" style={{ color: colors.muted, fontVariant: ["tabular-nums"] }}>
                        {batchProgress.current}/{batchProgress.total}
                      </Text>
                    </View>
                    <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
                      <View
                        className="h-full rounded-full"
                        style={{ backgroundColor: colors.emerald, width: `${batchProgress.total > 0 ? Math.round((batchProgress.current / batchProgress.total) * 100) : 0}%` }}
                      />
                    </View>
                    <Text className="text-xs" style={{ color: colors.muted }}>
                      {batchProgress.succeeded} downloaded · {batchProgress.skipped} skipped · {batchProgress.failed} failed
                    </Text>
                  </View>
                ) : null}

                {batchFailures.length > 0 ? (
                  <View className="gap-2">
                    <PressableScale scaleTo={1} onPress={() => setShowFailures((v) => !v)} className="self-start">
                      <Text className="text-sm font-medium" style={{ color: "#f87171" }}>
                        {batchFailures.length} track{batchFailures.length === 1 ? "" : "s"} failed{showFailures ? " ▲" : " ▼"}
                      </Text>
                    </PressableScale>
                    {showFailures ? (
                      <View className="gap-1">
                        {batchFailures.map((failure) => (
                          <Text key={failure} className="text-xs" style={{ color: colors.muted }}>{failure}</Text>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <PressableScale onPress={pickAudio} className="flex-row items-center gap-3 rounded-lg p-4" style={{ backgroundColor: "#1f1f1f" }}>
              <FileAudio size={22} color={colors.emerald} />
              <Text numberOfLines={1} className="flex-1" style={{ color: audio ? colors.foreground : colors.muted }}>
                {audio?.name ?? "Choose an audio file"}
              </Text>
            </PressableScale>
            <TextInput value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={colors.muted} style={inputStyle} />
            <TextInput value={artist} onChangeText={setArtist} placeholder="Artist" placeholderTextColor={colors.muted} style={inputStyle} />
            <PressableScale onPress={pickCover} className="flex-row items-center gap-3 rounded-lg p-4" style={{ backgroundColor: "#1f1f1f" }}>
              {cover ? (
                <View className="h-12 w-12 overflow-hidden rounded">
                  <CoverImage src={cover.uri} style={{ width: "100%", height: "100%" }} />
                </View>
              ) : (
                <ImageIcon size={22} color={colors.muted} />
              )}
              <Text className="flex-1" style={{ color: cover ? colors.foreground : colors.muted }}>
                {cover ? "Cover selected" : "Choose a cover (optional)"}
              </Text>
            </PressableScale>
            <PressableScale onPress={uploadFile} disabled={status.kind === "busy"} className="items-center rounded-full py-3" style={{ backgroundColor: colors.green, opacity: status.kind === "busy" ? 0.6 : 1 }}>
              <Text className="font-bold text-black">{status.kind === "busy" ? "Uploading…" : "Upload"}</Text>
            </PressableScale>
          </View>
        )}

        {status.kind === "error" && status.message ? <ErrorText>{status.message}</ErrorText> : null}
        {status.kind === "ok" && status.message ? (
          <Text style={{ color: colors.emerald }} className="text-sm font-medium">{status.message}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
