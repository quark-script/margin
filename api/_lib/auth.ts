import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";
import { supabaseStore, type Store } from "./store.js";

// Checks tokens; one client for all requests, so Supabase's signing keys stay cached.
const verifier = createClient(SUPABASE_URL || "https://invalid.local", SUPABASE_KEY || "missing", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/** Who is calling, and their way into the database (as themselves). */
export type Caller = { userId: string; store: Store };

/**
 * The bearer token of a request, checked with Supabase Auth: an access token it issued to an
 * OAuth app (an agent) or to the Margin app. Null when it's missing, expired or not ours.
 */
export async function authenticate(req: Request): Promise<Caller | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || !SUPABASE_URL || !SUPABASE_KEY) return null;
  const { data, error } = await verifier.auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims?.sub || claims.role !== "authenticated") return null;
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
    db: { schema: "notes" },
  });
  return { userId: claims.sub, store: supabaseStore(db, claims.sub) };
}
