import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname, useRouter } from "expo-router";
import { PressableScale } from "@/components/ui/PressableScale";
import { CreateTabIcon, HomeTabIcon, LibraryTabIcon, SearchTabIcon } from "@/components/icons/TabIcons";
import { selectionAsync } from "@/lib/haptics";
import { shouldNavigateToTabRoot, type RootTabPath } from "@/lib/tab-navigation-policy";
import { useUiStore } from "@/store/ui";
import { usePrefsStore } from "@/store/prefs";
import { layout } from "@/theme";

type TabKey = "index" | "search" | "library" | "create";

const TABS: { key: TabKey; label: string; path: RootTabPath; Icon: typeof HomeTabIcon }[] = [
  { key: "index", label: "Home", path: "/", Icon: HomeTabIcon },
  { key: "search", label: "Search", path: "/search", Icon: SearchTabIcon },
  { key: "library", label: "Library", path: "/library", Icon: LibraryTabIcon },
  // Create opens the create-menu sheet instead of navigating (handled in onPress).
  { key: "create", label: "Create", path: "/", Icon: CreateTabIcon },
];

// Auth screens take over the whole screen — no tab bar there.
const HIDDEN_ON = new Set(["/signin", "/register"]);

// Which tab "owns" the current route, so the right icon stays lit on pushed screens
// (e.g. /liked and /playlist were reached from Library). Home and Search match their
// own paths; every other pushed screen falls back to Library.
function activeTab(pathname: string): TabKey {
  if (pathname === "/") return "index";
  if (pathname.startsWith("/search")) return "search";
  return "library";
}

// Mirrors src/components/MobileNav.tsx: compact native icons and material selection.
// Mounted once in the root layout (not via the
// Tabs navigator's tabBar prop) so it persists on pushed stack screens too — liked,
// playlist, downloads, … — not just the tabs. Driven by the router: navigate() unwinds
// any pushed screen and switches tab in one step.
export function TabBar() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const openCreateMenu = useUiStore((s) => s.openCreateMenu);
  const showCreateTab = usePrefsStore((s) => s.showCreateTab);

  if (HIDDEN_ON.has(pathname)) return null;

  const active = activeTab(pathname);
  // Create can be hidden from Settings; when off, the other tabs spread evenly.
  const tabs = showCreateTab ? TABS : TABS.filter((tab) => tab.key !== "create");

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: layout.mobileNavHeight + insets.bottom,
        zIndex: 90,
        backgroundColor: "rgba(6,6,7,0.98)",
        borderTopWidth: 0.5,
        borderTopColor: "rgba(255,255,255,0.11)",
      }}
    >
      <View
        style={{
          height: layout.mobileNavHeight,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 10,
          paddingTop: 5,
          paddingBottom: 4,
        }}
      >
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          const onPress = () => {
            void selectionAsync();
            // Create isn't a destination — it opens the create-menu sheet over
            // whatever's on screen, leaving the active tab untouched.
            if (tab.key === "create") {
              openCreateMenu();
              return;
            }
            // A tab tap should return to that tab's root. Sub-screens (a playlist,
            // Liked, …) are PUSHED on the root stack on top of the tabs, so first pop
            // the stack back to the tabs: dismissAll() dispatches POP_TO_TOP, which
            // unwinds and unmounts them cleanly (like the header back button, but all
            // the way). Using navigate() to "go back" here instead pushes a SECOND tabs
            // instance and leaves the sub-screen mounted underneath — duplicates that
            // never unmount. Then switch tab only if we're not already on it.
            const hasDismissibleRoute = router.canDismiss();
            if (hasDismissibleRoute) router.dismissAll();
            // Dispatch after an unwind or when switching tabs. On a pushed
            // route, `isActive` describes the highlighted owner, not necessarily
            // the tab beneath it (Settings can be opened over Home, for example).
            if (shouldNavigateToTabRoot(pathname, tab.path, hasDismissibleRoute)) {
              router.navigate(tab.path);
            }
          };
          const tint = isActive ? "#fff" : "rgba(255,255,255,0.58)";
          return (
            <PressableScale
              key={tab.key}
              scaleTo={0.985}
              onPress={onPress}
              className="flex-1"
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={tab.label}
            >
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                }}
              >
                <tab.Icon active={isActive} color={tint} size={22} />
                <Text
                  style={{
                    color: tint,
                    fontSize: 10,
                    fontWeight: isActive ? "700" : "600",
                    letterSpacing: 0.1,
                  }}
                >
                  {tab.label}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}
