import { useState } from "react";
import { supabase } from "../lib/supabase";

type Mode = "signin" | "signup";

function friendlyError(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("invalid login")) return "Email or password is wrong.";
  if (m.includes("email not confirmed")) return "Confirm your email first — check your inbox for the link from Supabase.";
  if (m.includes("already registered")) return "An account with this email exists. Sign in instead.";
  if (m.includes("password should be")) return "Use a password with at least 8 characters.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Can't reach the server. Check your connection.";
  return msg;
}

export function Login() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          setInfo("Account created. Open the confirmation email, then come back and sign in.");
          setMode("signin");
        }
      }
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-10 w-full rounded-md bg-transparent px-3 text-[15px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-2 focus:ring-accent";

  return (
    <main className="safe-top flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-[340px]">
        <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-[10px] bg-ink text-[22px] font-bold text-paper">
          N
        </div>
        <h1 className="text-[26px] font-bold tracking-[-0.02em] text-ink">
          {mode === "signin" ? "Sign in to your notes" : "Create your account"}
        </h1>
        <p className="mt-1.5 text-[14px] text-muted">
          {mode === "signin" ? "Your pages sync across your phone and computer." : "One account for all your devices."}
        </p>

        <form onSubmit={submit} className="mt-7 space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink">Password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </label>

          {error && <p className="text-[13px] text-danger">{error}</p>}
          {info && <p className="text-[13px] text-ink">{info}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 h-10 w-full rounded-md bg-ink text-[15px] font-medium text-paper hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-[14px] text-muted">
          {mode === "signin" ? "No account yet? " : "Already have an account? "}
          <button
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setInfo(null);
            }}
            className="font-medium text-accent hover:underline"
          >
            {mode === "signin" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}
