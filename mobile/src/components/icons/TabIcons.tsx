import { Platform } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Svg, { Circle, Path } from "react-native-svg";

// Spotify Encore tab glyphs (24px grid), exact paths from src/components/MobileNav.tsx:
// outline at rest, filled when active.
type Props = { active: boolean; color: string; size?: number };

function IOSTabSymbol({
  name,
  active,
  color,
  size,
}: {
  name: SFSymbol;
  active: boolean;
  color: string;
  size: number;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      type="hierarchical"
      weight={active ? "semibold" : "medium"}
      animationSpec={
        active
          ? { effect: { type: "bounce", wholeSymbol: true }, speed: 1.2 }
          : undefined
      }
      style={{ width: size, height: size }}
    />
  );
}

export function HomeTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name={active ? "house.fill" : "house"}
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill={color}>
      {active ? (
        <Path d="M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z" />
      ) : (
        <Path d="M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z" />
      )}
    </Svg>
  );
}

export function SearchTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name="magnifyingglass"
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill={color}>
      <Path d="M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z" />
      {active ? <Circle cx="10.533" cy="10.558" r="4.75" /> : null}
    </Svg>
  );
}

export function LibraryTabIcon({ active, color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return (
      <IOSTabSymbol
        name={active ? "square.stack.fill" : "square.stack"}
        active={active}
        color={color}
        size={size}
      />
    );
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} fill={color}>
      {active ? (
        <Path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" />
      ) : (
        <Path d="M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z" />
      )}
    </Svg>
  );
}

// "Create" is an action (it opens the create sheet), not a selectable tab, so it
// renders the same + glyph regardless of `active`.
export function CreateTabIcon({ color, size = 24 }: Props) {
  if (Platform.OS === "ios") {
    return <IOSTabSymbol name="plus" active={false} color={color} size={size} />;
  }
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size}>
      <Path d="M12 4.5v15M4.5 12h15" fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
    </Svg>
  );
}
