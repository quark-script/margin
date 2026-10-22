import { supabase } from "./supabase";

const CACHE = "margin:google";

/** Last known answer, so the sign-in screen doesn't jump when the button appears. */
export function googleLastKnown() {
  try {
    return localStorage.getItem(CACHE) === "1";
  } catch {
    return false;
  }
}

let check: Promise<boolean> | null = null;

/**
 * Is Google sign-in switched on for the project? Read from Supabase's public auth settings, so
 * the button shows up once it's configured there, with no new release.
 */
export function googleEnabled(): Promise<boolean> {
  check ??= fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { external?: { google?: boolean } } | null) => {
      const on = Boolean(s?.external?.google);
      try {
        localStorage.setItem(CACHE, on ? "1" : "0");
      } catch {
        /* storage blocked */
      }
      return on;
    })
    .catch(() => googleLastKnown());
  return check;
}

/**
 * Off to Google and back to this same site (where any "go back to this page afterwards" is
 * remembered). Lets people with several Google accounts pick one.
 */
export const signInWithGoogle = () =>
  supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/`, queryParams: { prompt: "select_account" } },
  });
