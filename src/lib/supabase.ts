import { createClient, type EmailOtpType } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in .env");
}

/**
 * Auth emails link to /auth/confirm?token_hash=...&type=... on this site, so the link shows our
 * own address and a mail scanner that only fetches the page can't use up the token. Verified in
 * auth start().
 */
export const emailLink = (() => {
  if (window.location.pathname !== "/auth/confirm") return null;
  const q = new URLSearchParams(window.location.search);
  const token_hash = q.get("token_hash");
  const type = q.get("type") as EmailOtpType | null;
  history.replaceState(null, "", "/");
  return token_hash && type ? { token_hash, type } : null;
})();

// Read before createClient, which consumes the URL hash of a password-reset link. The
// PASSWORD_RECOVERY event can fire before anyone has subscribed, so it can't be relied on alone.
export const recoveryInUrl = /[#&]type=recovery\b/.test(window.location.hash) || emailLink?.type === "recovery";

/** An expired or used email link, or a cancelled Google sign-in, comes back with the reason in the URL; same timing. */
export const authLinkErrorCode = (() => {
  const h = new URLSearchParams(window.location.hash.slice(1));
  const q = new URLSearchParams(window.location.search);
  const p = h.get("error") ? h : q.get("error") ? q : null;
  return p ? (p.get("error_code") ?? p.get("error") ?? "unknown") : null;
})();

// All app tables live in the `notes` schema.
export const supabase = createClient(url, key, {
  db: { schema: "notes" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Where auth emails send people back to. Must equal the Supabase Site URL for the direct links. */
export const SITE_URL = (import.meta.env.VITE_SITE_URL as string | undefined) || window.location.origin;

export const MEDIA_BUCKET = "notes-media";
export const MEDIA_PREFIX = "notes-media:";
