import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !key) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in .env");
}

// Read before createClient, which consumes the URL hash of a password-reset link. The
// PASSWORD_RECOVERY event can fire before anyone has subscribed, so it can't be relied on alone.
export const recoveryInUrl = /[#&]type=recovery\b/.test(window.location.hash);

// All app tables live in the `notes` schema (shared project with upkeep).
export const supabase = createClient(url, key, {
  db: { schema: "notes" },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const MEDIA_BUCKET = "notes-media";
export const MEDIA_PREFIX = "notes-media:";
