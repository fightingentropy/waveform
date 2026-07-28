import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { PressableScale } from "@/components/ui/PressableScale";
import { Screen } from "@/components/ui/Screen";
import { colors } from "@/theme";

export function AuthShell({
  eyebrow = "YOUR MUSIC",
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <Screen ambience="auth">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: 24,
            paddingVertical: 32,
          }}
        >
          <View style={{ marginBottom: 32 }}>
            <View
              style={{
                width: 40,
                height: 40,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 24,
              }}
            >
              <SymbolView
                name="waveform"
                size={29}
                tintColor="#fff"
                type="hierarchical"
                weight="medium"
                style={{ width: 32, height: 32 }}
              />
            </View>
            <Text
              style={{
                color: colors.dim,
                fontSize: 11,
                fontWeight: "600",
                letterSpacing: 1.8,
                marginBottom: 10,
              }}
            >
              {eyebrow}
            </Text>
            <Text
              style={{
                color: colors.foreground,
                fontSize: 36,
                lineHeight: 40,
                fontWeight: "700",
                letterSpacing: -1,
              }}
            >
              {title}
            </Text>
            <Text
              style={{
                color: colors.muted,
                fontSize: 15,
                lineHeight: 22,
                marginTop: 10,
                maxWidth: 330,
              }}
            >
              {subtitle}
            </Text>
          </View>

          <View>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function AuthField(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor="rgba(255,255,255,0.46)"
      selectionColor={colors.green}
      {...props}
      style={[
        {
          height: 52,
          paddingHorizontal: 16,
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          borderWidth: 0.5,
          borderColor: colors.line,
          color: colors.foreground,
          fontSize: 16,
        },
        props.style,
      ]}
    />
  );
}

export function AuthPrimaryButton({
  label,
  busyLabel,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={{
        height: 52,
        borderRadius: 12,
        borderCurve: "continuous",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.green,
        opacity: disabled ? 0.52 : 1,
      }}
    >
      <Text style={{ color: "#050505", fontSize: 15, fontWeight: "700" }}>
        {busy ? busyLabel : label}
      </Text>
    </PressableScale>
  );
}
