import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../store/auth";

// Sign-ups are disabled on the shared Supabase project: this is a single-user app,
// so there is deliberately no "create account" path here.
type Mode = "signin" | "forgot";

function friendlyError(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("invalid login")) return "Email or password is wrong.";
  if (m.includes("email not confirmed")) return "Confirm your email first. Check your inbox for the link.";
  if (m.includes("password should be")) return "Use a password with at least 8 characters.";
  if (m.includes("same password") || m.includes("different from the old")) return "Pick a password you haven't used before.";
  if (m.includes("rate limit") || m.includes("security purposes")) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Can't reach the server. Check your connection.";
  return msg;
}

const field =
  "h-10 w-full rounded-md bg-transparent px-3 text-[15px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-2 focus:ring-accent";
const primary =
  "mt-1 h-10 w-full rounded-md bg-ink text-[15px] font-medium text-paper hover:opacity-90 disabled:opacity-50";

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="safe-top flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-[340px]">
        <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-[10px] bg-ink text-[22px] font-bold text-paper">
          M
        </div>
        <h1 className="text-[26px] font-bold tracking-[-0.02em] text-ink">{title}</h1>
        <p className="mt-1.5 text-[14px] text-muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

export function Login() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
  };

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
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setInfo("If that email has an account, a reset link is on its way. Open it on this device.");
      }
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title={mode === "signin" ? "Sign in to Margin" : "Reset your password"}
      subtitle={
        mode === "signin"
          ? "Your pages sync across your phone and computer."
          : "We'll email you a link to set a new password."
      }
    >
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
        {mode === "signin" && (
          <div>
            {/* The button stays outside the <label>: a label binds to its first control. */}
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="password" className="text-[13px] font-medium text-ink">
                Password
              </label>
              <button
                type="button"
                onClick={() => switchMode("forgot")}
                className="text-[13px] text-muted hover:text-ink"
              >
                Forgot password?
              </button>
            </div>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </div>
        )}

        {error && <p className="text-[13px] text-danger">{error}</p>}
        {info && <p className="text-[13px] text-ink">{info}</p>}

        <button type="submit" disabled={busy} className={primary}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Send reset link"}
        </button>
      </form>

      {mode === "forgot" && (
        <button onClick={() => switchMode("signin")} className="mt-6 text-[14px] font-medium text-accent hover:underline">
          Back to sign in
        </button>
      )}
    </Shell>
  );
}

/** Shown after opening a password-reset link: Supabase has signed us in for recovery only. */
export function SetPassword() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishRecovery = useAuth((s) => s.finishRecovery);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setError(friendlyError(error.message));
    else finishRecovery();
  };

  return (
    <Shell title="Set a new password" subtitle="Choose a password with at least 8 characters.">
      <form onSubmit={submit} className="mt-7 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink">New password</span>
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
        </label>
        {error && <p className="text-[13px] text-danger">{error}</p>}
        <button type="submit" disabled={busy} className={primary}>
          {busy ? "Please wait…" : "Save password"}
        </button>
      </form>
    </Shell>
  );
}
