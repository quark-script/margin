import { authenticate } from "./_lib/auth.js";
import { handleMcp } from "./_lib/server.js";

// https://<site>/mcp (rewritten here by vercel.json): Margin for AI agents.
const handler = (req: Request) => handleMcp(req, authenticate);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
export const OPTIONS = handler;
