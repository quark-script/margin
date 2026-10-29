import { SUPABASE_URL } from "./_lib/config.js";
import { protectedResource } from "./_lib/server.js";

// /.well-known/oauth-protected-resource[/mcp] (rewritten here by vercel.json): Supabase Auth
// signs people in for the MCP server.
const handler = (req: Request) => protectedResource(req, `${SUPABASE_URL}/auth/v1`);

export const GET = handler;
export const OPTIONS = handler;
