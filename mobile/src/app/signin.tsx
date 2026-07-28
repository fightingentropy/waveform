import { useState } from "react";
import { View } from "react-native";
import {
  AuthField,
  AuthPrimaryButton,
  AuthShell,
} from "@/components/auth/AuthChrome";
import { ErrorText } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";

export default function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // AuthenticatedApp owns the auth-route transition. Calling back() here
      // races that redirect and warns when sign-in is the root route.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid email or password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Welcome back."
      subtitle="Pick up exactly where you left off, online or offline."
    >
      <View style={{ gap: 12 }}>
          <AuthField
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <AuthField
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            autoComplete="password"
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
          />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <AuthPrimaryButton
            onPress={submit}
            disabled={busy || !email || !password}
            busy={busy}
            label="Sign in"
            busyLabel="Signing in…"
          />
      </View>
    </AuthShell>
  );
}
