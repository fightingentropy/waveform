import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@/client/auth";

function resolveRedirectTarget(
  state: unknown,
  search: string,
): string {
  // Prefer an explicit return-to passed via navigation state (e.g. from a
  // guard that bounced the user to /signin), then fall back to ?next=, else
  // home. Only accept same-origin path redirects to avoid open-redirects.
  const fromState =
    state && typeof state === "object" && "from" in state
      ? (state as { from?: unknown }).from
      : undefined;
  const next =
    typeof fromState === "string"
      ? fromState
      : new URLSearchParams(search).get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      navigate(resolveRedirectTarget(location.state, location.search), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid email or password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-16 px-4">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="signin-email" className="block text-sm mb-1">Email</label>
          <input
            id="signin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "signin-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        <div>
          <label htmlFor="signin-password" className="block text-sm mb-1">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? "signin-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        {error && (
          <div id="signin-error" role="alert" className="text-sm text-red-600">
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full h-10 rounded bg-foreground text-background disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-white/[0.62]">
        Private personal library. Sign-in only.
      </p>
    </div>
  );
}
