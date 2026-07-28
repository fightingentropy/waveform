import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { FooterButton } from "@/components/SettingsControls";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { ErrorText } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { colors } from "@/theme";

export default function AccountSettingsScreen() {
  const router = useRouter();
  const { user, deleteAccount } = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performDeletion = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      router.replace("/signin");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete your account");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeletion = () => {
    Alert.alert(
      "Delete account permanently?",
      "Your profile, playlists, likes, listening history, uploaded music, and server data will be removed. Downloads for this account will also be erased from this device. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete permanently",
          style: "destructive",
          onPress: () => void performDeletion(),
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <Screen topInset={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 18,
            paddingBottom: CONTENT_BOTTOM_INSET,
          }}
        >
          <Text style={{ color: colors.dim, fontSize: 12, fontWeight: "600", letterSpacing: 1.2 }}>
            SIGNED IN AS
          </Text>
          <Text
            selectable
            style={{ color: colors.foreground, fontSize: 17, fontWeight: "600", marginTop: 8 }}
          >
            {user?.email}
          </Text>

          <View style={{ marginTop: 40 }}>
            <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "700" }}>
              Delete account
            </Text>
            <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8 }}>
              Enter your password, then confirm the permanent deletion. Signing out is not enough to
              delete your account.
            </Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              placeholder="Password"
              placeholderTextColor={colors.dim}
              selectionColor={colors.foreground}
              accessibilityLabel="Password to confirm account deletion"
              style={{
                height: 50,
                marginTop: 18,
                paddingHorizontal: 14,
                borderRadius: 12,
                borderCurve: "continuous",
                borderWidth: 0.5,
                borderColor: colors.hairline,
                backgroundColor: colors.surface,
                color: colors.foreground,
                fontSize: 16,
              }}
            />
            {error ? (
              <View style={{ marginTop: 10 }}>
                <ErrorText>{error}</ErrorText>
              </View>
            ) : null}
            <View style={{ marginTop: 10 }}>
              <FooterButton
                icon={Trash2}
                label="Delete account"
                tone="danger"
                busy={busy}
                disabled={!password.trim()}
                divider
                onPress={confirmDeletion}
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
