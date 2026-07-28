import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, View } from "react-native";
import {
  ArrowDownToLine,
  CheckCircle2,
  Cloud,
  Heart,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react-native";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { FooterButton } from "@/components/SettingsControls";
import { formatBytes, getDiskUsage, type DiskUsage } from "@/lib/disk-usage";
import { hasUserDownloadScope, useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";

// Offline downloads management (RN port of src/components/OfflineSettings.tsx).
// A compact storage summary, then verification / sync / failures as hairline-
// separated rows with contextual actions: "Retry" appears only when a download
// failed, "Sync now" only when mutations are pending. The header ↻ recomputes
// storage + disk on demand; "Clear downloads" is a destructive footer button.

const AMBER = "#fbbf24";

function MiniButton({
  label,
  onPress,
  busy,
  tone = "default",
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  tone?: "default" | "warn";
}) {
  const fg = tone === "warn" ? AMBER : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: colors.cardActive,
        opacity: busy ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Row({
  icon: Icon,
  iconColor,
  busy,
  leading,
  title,
  titleColor,
  value,
  right,
  first,
}: {
  icon: LucideIcon;
  iconColor?: string;
  busy?: boolean;
  leading?: ReactNode;
  title: string;
  titleColor?: string;
  value?: string;
  right?: ReactNode;
  first?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 56,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: colors.line,
      }}
    >
      {leading ? (
        <View style={{ width: 18, alignItems: "center" }}>{leading}</View>
      ) : busy ? (
        <ActivityIndicator size="small" color={iconColor ?? colors.muted} style={{ width: 18 }} />
      ) : (
        <Icon size={18} color={iconColor ?? colors.muted} />
      )}
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: titleColor ?? colors.foreground, fontSize: 15, fontWeight: "500" }}
      >
        {title}
      </Text>
      {value ? (
        <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 14, marginRight: right ? 4 : 0 }}>
          {value}
        </Text>
      ) : null}
      {right}
    </View>
  );
}

export function OfflineSettings() {
  const records = useOfflineStore((s) => s.records);
  const progressMap = useOfflineStore((s) => s.progress);
  const hydrate = useOfflineStore((s) => s.hydrate);
  const refreshStorage = useOfflineStore((s) => s.refreshStorage);
  const storageBytes = useOfflineStore((s) => s.storageBytes);
  const syncStatus = useOfflineStore((s) => s.syncStatus);
  const syncError = useOfflineStore((s) => s.syncError);
  const pendingMutations = useOfflineStore((s) => s.pendingMutations);
  const failedMutations = useOfflineStore((s) => s.failedMutations);
  const verificationStatus = useOfflineStore((s) => s.verificationStatus);
  const verificationCheckedAt = useOfflineStore((s) => s.verificationCheckedAt);
  const verifiedDownloads = useOfflineStore((s) => s.verifiedDownloads);
  const missingDownloads = useOfflineStore((s) => s.missingDownloads);
  const verificationError = useOfflineStore((s) => s.verificationError);
  const verifyDownloads = useOfflineStore((s) => s.verifyDownloads);
  const retryFailedDownloads = useOfflineStore((s) => s.retryFailedDownloads);
  const syncOfflineMutations = useOfflineStore((s) => s.syncOfflineMutations);
  const retryFailedMutations = useOfflineStore((s) => s.retryFailedMutations);
  const clearDownloads = useOfflineStore((s) => s.clearDownloads);
  const autoDownloadLiked = useOfflineStore((s) => s.autoDownloadLiked);
  const setAutoDownloadLiked = useOfflineStore((s) => s.setAutoDownloadLiked);

  const [disk, setDisk] = useState<DiskUsage | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Recompute device free/used alongside the store's downloads total whenever
  // records change (a download finished/was removed) or storage refreshes.
  useEffect(() => {
    let cancelled = false;
    getDiskUsage()
      .then((usage) => {
        if (!cancelled) setDisk(usage);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [records, storageBytes]);

  const { downloaded, active, failed, downloadingKey } = useMemo(() => {
    const entries = Object.entries(records);
    const list = entries.map(([, r]) => r).filter(hasUserDownloadScope);
    return {
      downloaded: list.filter((r) => r.status === "ready").length,
      active: list.filter((r) => r.status === "queued" || r.status === "downloading").length,
      failed: list.filter((r) => r.status === "error").length,
      // The serial pump runs one download at a time; surface its live fraction.
      downloadingKey: entries.find(([, r]) => r.status === "downloading")?.[0],
    };
  }, [records]);
  const activeProgress = downloadingKey ? progressMap[downloadingKey] ?? 0 : undefined;
  // Overall batch progress for the "Downloading N songs…" row: completed songs
  // (plus the in-flight song's byte fraction) over the total being downloaded.
  // The per-song byte fraction alone read ~0% because each small audio file
  // flips 0→100 almost instantly — this reflects the real "243 of 1349 done".
  const totalBatch = downloaded + active;
  const overallProgress = totalBatch > 0 ? (downloaded + (activeProgress ?? 0)) / totalBatch : 0;

  const freeBytes = disk?.free;
  const usedByDownloads = disk?.usedByDownloads ?? storageBytes;

  const verificationLabel =
    verificationStatus === "checking"
      ? "Checking downloads"
      : verificationStatus === "ok"
        ? "Downloads verified"
        : verificationStatus === "repair-needed"
          ? "Repair queued"
          : verificationStatus === "failed"
            ? "Verification failed"
            : "Not checked yet";
  const VerificationIcon: LucideIcon =
    verificationStatus === "ok"
      ? CheckCircle2
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? TriangleAlert
        : ShieldCheck;
  const verificationTint =
    verificationStatus === "ok"
      ? colors.emerald
      : verificationStatus === "repair-needed" || verificationStatus === "failed"
        ? AMBER
        : colors.muted;

  const syncHealthy =
    pendingMutations === 0 &&
    failedMutations === 0 &&
    syncStatus !== "auth-required" &&
    syncStatus !== "failed";
  const syncSummary =
    failedMutations > 0
      ? `${failedMutations} failed${pendingMutations > 0 ? ` · ${pendingMutations} pending` : ""}`
      : pendingMutations === 0
      ? "Up to date"
      : `${pendingMutations} pending${syncStatus === "auth-required" ? " · sign in" : ""}`;
  const showSyncAction =
    pendingMutations > 0 ||
    failedMutations > 0 ||
    syncStatus === "failed" ||
    syncStatus === "auth-required";

  const handleRefresh = () => {
    void refreshStorage();
    getDiskUsage().then(setDisk).catch(() => undefined);
  };

  const handleClearDownloads = () => {
    Alert.alert(
      "Clear downloads",
      "Remove all offline downloads from this device?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: () => void clearDownloads() },
      ],
      { cancelable: true },
    );
  };

  const summary =
    `${downloaded} ${downloaded === 1 ? "song" : "songs"} · ${formatBytes(usedByDownloads)}` +
    (freeBytes == null ? "" : ` · ${formatBytes(freeBytes)} free`);

  return (
    <View>
      {/* Header: title + one-line summary + refresh */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 16, paddingBottom: 10 }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }}>Downloads</Text>
          <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 13, marginTop: 3 }}>
            {summary}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh storage"
          hitSlop={10}
          onPress={handleRefresh}
          style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.6 : 1 })}
        >
          <RefreshCw size={18} color={colors.muted} />
        </Pressable>
      </View>

      {/* Status rows — flat, hairline-separated, like the rest of Settings */}
      <View style={{ paddingHorizontal: 16 }}>
        {/* Active downloads — only while something is downloading */}
        {active > 0 ? (
          <Row
            first
            icon={ArrowDownToLine}
            iconColor={colors.emerald}
            leading={<DownloadProgressRing size={18} strokeWidth={2} progress={overallProgress} />}
            title={`Downloading ${active} ${active === 1 ? "song" : "songs"}…`}
            value={`${Math.round(overallProgress * 100)}%`}
          />
        ) : null}

        {/* Verification */}
        <Row
          first={active === 0}
          icon={VerificationIcon}
          iconColor={verificationTint}
          busy={verificationStatus === "checking"}
          title={verificationLabel}
          value={
            verificationCheckedAt
              ? `${verifiedDownloads} ok${missingDownloads > 0 ? ` · ${missingDownloads} missing` : ""}`
              : undefined
          }
          right={<MiniButton label="Verify" busy={verificationStatus === "checking"} onPress={() => void verifyDownloads()} />}
        />

        {/* Sync */}
        <Row
          icon={syncHealthy ? Cloud : TriangleAlert}
          iconColor={syncHealthy ? colors.muted : AMBER}
          busy={syncStatus === "syncing"}
          title="Sync"
          value={syncSummary}
          right={
            showSyncAction ? (
              <MiniButton
                label={failedMutations > 0 ? "Retry" : "Sync now"}
                tone={failedMutations > 0 ? "warn" : "default"}
                busy={syncStatus === "syncing"}
                onPress={() =>
                  void (failedMutations > 0
                    ? retryFailedMutations()
                    : syncOfflineMutations())
                }
              />
            ) : undefined
          }
        />

        {/* Failed downloads → retry (only when present) */}
        {failed > 0 ? (
          <Row
            icon={TriangleAlert}
            iconColor={AMBER}
            titleColor={AMBER}
            title={`${failed} failed download${failed === 1 ? "" : "s"}`}
            right={<MiniButton label="Retry" tone="warn" onPress={() => void retryFailedDownloads()} />}
          />
        ) : null}

        {/* Auto-download toggle */}
        <Row
          icon={Heart}
          title="Auto-download liked songs"
          right={
            <Switch
              value={autoDownloadLiked}
              onValueChange={setAutoDownloadLiked}
              trackColor={{ true: "rgba(255,255,255,0.42)", false: "#3a3a3a" }}
              thumbColor="#fff"
            />
          }
        />

        {/* Error lines (rare) */}
        {syncError ? <Text style={{ color: AMBER, fontSize: 13, paddingTop: 4 }}>{syncError}</Text> : null}
        {verificationError ? <Text style={{ color: AMBER, fontSize: 13, paddingTop: 4 }}>{verificationError}</Text> : null}

        {/* Clear downloads — destructive action as the final row in the list */}
        <FooterButton divider icon={Trash2} label="Clear downloads" tone="danger" onPress={handleClearDownloads} />
      </View>
    </View>
  );
}
