import { useState } from "react";
import { Link } from "react-router";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Registration failed");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto py-16 px-4">
        <h1 className="text-2xl font-semibold mb-4">Check your email</h1>
        <p className="text-sm text-white/[0.68] mb-6">
          If {email || "that address"} is new, we&apos;ve sent a verification link to it. You can sign in right away —
          just verify when you get a chance.
        </p>
        <Link
          to="/signin"
          className="inline-flex h-10 items-center justify-center rounded bg-foreground px-4 text-background"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto py-16 px-4">
      <h1 className="text-2xl font-semibold mb-6">Create your account</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="register-name" className="block text-sm mb-1">Name</label>
          <input
            id="register-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={error ? "register-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
          />
        </div>
        <div>
          <label htmlFor="register-email" className="block text-sm mb-1">Email</label>
          <input
            id="register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "register-error" : undefined}
            className="w-full border rounded px-3 py-2 bg-transparent"
            required
          />
        </div>
        <div>
          <label htmlFor="register-password" className="block text-sm mb-1">Password</label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? "register-error" : "register-password-hint"}
            className="w-full border rounded px-3 py-2 bg-transparent"
            minLength={8}
            maxLength={128}
            required
          />
          <p id="register-password-hint" className="mt-1 text-xs text-white/[0.5]">
            At least 8 characters.
          </p>
        </div>
        {error && (
          <div id="register-error" role="alert" className="text-sm text-red-600">
            {error}
          </div>
        )}
        <button type="submit" disabled={loading} className="w-full h-10 rounded bg-foreground text-background disabled:opacity-50">
          {loading ? "Creating..." : "Create account"}
        </button>
      </form>
      <p className="mt-4 text-sm">
        Already have an account? <Link className="underline" to="/signin">Sign in</Link>
      </p>
    </div>
  );
}
