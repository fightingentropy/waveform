import { Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { sleepTimerRemainingMinutes, usePlayerStore } from "@/store/player";

const OPTIONS = [5, 15, 30, 45, 60];
const MONO_ACTIVE = "rgba(255,255,255,0.94)";
const MONO_SECONDARY = "rgba(255,255,255,0.58)";

export function SleepTimerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtEndOfTrack = usePlayerStore((s) => s.sleepAtEndOfTrack);
  const startSleepTimer = usePlayerStore((s) => s.startSleepTimer);
  const setSleepAtEndOfTrack = usePlayerStore((s) => s.setSleepAtEndOfTrack);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);

  const active = sleepTimerEndsAt != null || sleepAtEndOfTrack;
  const remainingMinutes =
    sleepTimerEndsAt != null ? sleepTimerRemainingMinutes(sleepTimerEndsAt) : null;

  const Row = ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) => (
    <PressableScale
      scaleTo={1}
      onPress={() => {
        onPress();
        onClose();
      }}
      className="flex-row items-center justify-between px-5"
      style={{ minHeight: 56 }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      <Text style={{ color: MONO_ACTIVE, fontSize: 16, fontWeight: "500" }}>
        {label}
      </Text>
      {selected ? <Check size={20} color={MONO_ACTIVE} /> : null}
    </PressableScale>
  );

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={active ? 0.62 : 0.56} zIndex={200}>
      <View style={{ paddingBottom: 32 }}>
        <View className="px-5 pb-2 pt-1">
          <Text style={{ color: MONO_ACTIVE, fontSize: 20, fontWeight: "600" }}>
            Sleep timer
          </Text>
          {sleepTimerEndsAt != null ? (
            <Text className="mt-1 text-sm" style={{ color: MONO_SECONDARY }}>
              {remainingMinutes} min left
            </Text>
          ) : null}
        </View>
        {OPTIONS.map((m) => (
          <Row
            key={m}
            label={`${m} minutes`}
            selected={remainingMinutes === m}
            onPress={() => startSleepTimer(m)}
          />
        ))}
        <Row label="End of track" selected={sleepAtEndOfTrack} onPress={setSleepAtEndOfTrack} />
        {active ? <Row label="Turn off" selected={false} onPress={cancelSleepTimer} /> : null}
      </View>
    </Sheet>
  );
}
