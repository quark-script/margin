import { useEffect, useState } from "react";
import { authLinkErrorCode, SITE_URL, supabase } from "../lib/supabase";
import { useAuth } from "../store/auth";
import { useTheme } from "../lib/theme";
import { Captcha, CAPTCHA_SITE_KEY } from "../components/Captcha";
import { rememberNext } from "../lib/next";

type Mode = "signin" | "signup" | "forgot" | "sent";

function friendlyError(msg: string) {
  const m = msg.toLowerCase();
  if (m.includes("invalid login")) return "Email or password is wrong.";
  if (m.includes("email not confirmed")) return "Confirm your email first. Check your inbox for the link.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with this email already exists. Sign in instead.";
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) return "New sign-ups are closed right now.";
  if (m.includes("password should be") || m.includes("weak password")) return "Use a stronger password: at least 8 characters.";
  if (m.includes("same password") || m.includes("different from the old")) return "Pick a password you haven't used before.";
  if (m.includes("captcha")) return "Please complete the check above and try again.";
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
        {/* A plain link: this screen can render outside the router (password recovery). */}
        <a
          href="/"
          aria-label="Margin home"
          className="mb-8 flex h-11 w-11 items-center justify-center rounded-[10px] bg-ink text-[22px] font-bold text-paper"
        >
          M
        </a>
        <h1 className="text-[26px] font-bold tracking-[-0.02em] text-ink">{title}</h1>
        <p className="mt-1.5 text-[14px] text-muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

const EXPIRED_LINK = "That link has expired or was already used. Request a new one.";

/** Supabase sends expired or used email links back with the reason in the URL hash. */
function linkError(): string | null {
  if (!authLinkErrorCode) return null;
  if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  return authLinkErrorCode === "otp_expired" ? EXPIRED_LINK : "That link didn't work. Request a new one.";
}

export function Login({ initialMode = "signin" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  // Arrived from "Sign in to edit" (?next=) or opened a page link while signed out: go back there
  // afterwards. Not after signing out, which leaves this screen on whatever page you were on.
  const [returnTo] = useState(
    () =>
      rememberNext(new URLSearchParams(window.location.search).get("next")) ??
      (useAuth.getState().signedOut ? null : rememberNext(window.location.pathname)),
  );
  // Invitation emails link here with the invited address filled in.
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get("email") ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(linkError);
  const [info, setInfo] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const isDark = useTheme((s) => s.isDark);
  const linkFailed = useAuth((s) => s.linkFailed);
  useEffect(() => {
    if (linkFailed) setError(EXPIRED_LINK);
  }, [linkFailed]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
  };

  const opts = () => (captcha ? { captchaToken: captcha } : {});
  const redirect = SITE_URL;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (CAPTCHA_SITE_KEY && !captcha) return setError("Please complete the check above first.");
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password, options: opts() });
        if (error) throw error;
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { ...opts(), emailRedirectTo: redirect },
        });
        if (error) throw error;
        // With email confirmation on there's no session yet: ask them to check their inbox.
        if (!data.session) setMode("sent");
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { ...opts(), redirectTo: redirect });
        if (error) throw error;
        setInfo("If that email has an account, a reset link is on its way. Open it on this device.");
      }
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
      setCaptchaReset((n) => n + 1); // tokens are single use
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.resend({ type: "signup", email, options: { ...opts(), emailRedirectTo: redirect } });
    setBusy(false);
    setCaptchaReset((n) => n + 1);
    if (error) setError(friendlyError(error.message));
    else setInfo("Sent again. It can take a minute; check spam too.");
  };

  if (mode === "sent") {
    return (
      <Shell title="Check your email" subtitle={`We sent a link to ${email}. Open it to finish creating your account.`}>
        <div className="mt-7 space-y-3">
          <Captcha onToken={setCaptcha} resetKey={captchaReset} dark={isDark} />
          {error && <p className="text-[13px] text-danger">{error}</p>}
          {info && <p className="text-[13px] text-ink">{info}</p>}
          <button onClick={() => void resend()} disabled={busy} className={primary}>
            {busy ? "Please wait…" : "Send the link again"}
          </button>
        </div>
        <button onClick={() => switchMode("signin")} className="mt-6 text-[14px] font-medium text-accent hover:underline">
          Back to sign in
        </button>
      </Shell>
    );
  }

  const titles: Record<Exclude<Mode, "sent">, [string, string]> = {
    signin: ["Sign in to Margin", "Your pages sync across your phone and computer."],
    signup: ["Create your account", "Notes that work offline and sync everywhere."],
    forgot: ["Reset your password", "We'll email you a link to set a new password."],
  };
  const [title, defaultSubtitle] = titles[mode];
  // "Sign in to edit" on a shared page adds intent=edit.
  const returnHint =
    new URLSearchParams(window.location.search).get("intent") === "edit"
      ? "Sign in or create an account to edit the shared page."
      : "Sign in or create an account to open this page.";
  const subtitle = returnTo && mode !== "forgot" ? returnHint : defaultSubtitle;
  const cta = { signin: "Sign in", signup: "Create account", forgot: "Send reset link" }[mode];

  return (
    <Shell title={title} subtitle={subtitle}>
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
        {mode !== "forgot" && (
          <div>
            {/* The button stays outside the <label>: a label binds to its first control. */}
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="password" className="text-[13px] font-medium text-ink">
                Password
              </label>
              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => switchMode("forgot")}
                  className="text-[13px] text-muted hover:text-ink"
                >
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : undefined}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
            {mode === "signup" && <p className="mt-1.5 text-[12px] text-muted">At least 8 characters.</p>}
          </div>
        )}

        <Captcha onToken={setCaptcha} resetKey={captchaReset} dark={isDark} />
        {error && <p className="text-[13px] text-danger">{error}</p>}
        {info && <p className="text-[13px] text-ink">{info}</p>}

        <button type="submit" disabled={busy} className={primary}>
          {busy ? "Please wait…" : cta}
        </button>
      </form>

      <p className="mt-6 text-[14px] text-muted">
        {mode === "signin" ? (
          <>
            New to Margin?{" "}
            <button onClick={() => switchMode("signup")} className="font-medium text-accent hover:underline">
              Create an account
            </button>
          </>
        ) : (
          <>
            {mode === "signup" ? "Already have an account? " : ""}
            <button onClick={() => switchMode("signin")} className="font-medium text-accent hover:underline">
              {mode === "signup" ? "Sign in" : "Back to sign in"}
            </button>
          </>
        )}
      </p>
    </Shell>
  );
}

/** Shown after opening a password-reset link: Supabase has signed us in for recovery only. */
export function SetPassword() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishRecovery = useAuth((s) => s.finishRecovery);
  const cancelable = useAuth((s) => s.changingPassword);

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
      {cancelable && (
        <button onClick={finishRecovery} className="mt-6 text-[14px] font-medium text-accent hover:underline">
          Cancel
        </button>
      )}
    </Shell>
  );
}
