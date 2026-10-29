// Settings for the MCP server. The Supabase URL and publishable key are the same public values
// the app ships to the browser; data is protected by row level security and the caller's token.

export const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
export const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";

// Same as src/lib/supabase.ts, src/lib/local.ts and src/lib/daily.ts.
export const MEDIA_BUCKET = "notes-media";
export const MEDIA_PREFIX = "notes-media:";
export const DAILY_PARENT_TITLE = "Daily notes";

/** Answers to browsers and web-based agents: anyone may call, the token decides what they get. */
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
