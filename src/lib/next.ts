// Where to go after signing in: back to a shared page the visitor wanted to edit, a page
// someone invited them to, or an AI app waiting to be connected. Kept in localStorage so it
// survives the email-confirmation round trip of a new account.

const KEY = "margin:next";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // an abandoned sign-in shouldn't redirect days later

/**
 * Only page paths and an AI app's connect request are accepted, so a crafted link can't send
 * people elsewhere.
 */
const PAGE_PATH = /^\/(s\/[\w-]+(\/[\w-]+)?|p\/[\w-]+|shared\/[\w-]+(\/[\w-]+)?|oauth\/consent\?authorization_id=[\w-]+)$/;
const safe = (path: string | null) => (path && PAGE_PATH.test(path) ? path : null);

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
