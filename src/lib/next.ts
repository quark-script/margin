// Where to go after signing in, e.g. back to a shared page the visitor wanted to edit. Kept in
// localStorage so it survives the email-confirmation round trip of a new account.

const KEY = "margin:next";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // an abandoned sign-in shouldn't redirect days later

/** Only shared-page paths are accepted, so a crafted link can't send people elsewhere. */
const safe = (path: string | null) => (path && /^\/s\/[\w-]+(\/[\w-]+)?$/.test(path) ? path : null);

export function rememberNext(path: string | null) {
  const p = safe(path);
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify({ p, at: Date.now() }));
  } catch {
    /* storage blocked: they'll land on their own pages instead */
  }
  return p;
}

export function takeNext(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { p?: string; at?: number } | null;
    localStorage.removeItem(KEY);
    return saved && Date.now() - (saved.at ?? 0) < MAX_AGE_MS ? safe(saved.p ?? null) : null;
  } catch {
    return null;
  }
}
