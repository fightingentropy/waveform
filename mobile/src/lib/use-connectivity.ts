import { useSyncExternalStore } from "react";
import { getIsOnline, subscribeOnline } from "@/lib/connectivity";

// React bridge for the process-wide reachability signal. useSyncExternalStore
// closes the render/subscribe race and keeps consumers current when airplane mode
// changes while their screen or sheet remains mounted.
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getIsOnline, () => true);
}
