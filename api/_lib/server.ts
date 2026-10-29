import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CORS } from "./config.js";
import type { Caller } from "./auth.js";
import { INSTRUCTIONS, registerTools } from "./tools.js";

const withCors = (res: Response) => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

/** The public address of this server, as the caller reached it. */
export const originOf = (req: Request) => new URL(req.url).origin;

/**
 * Margin's MCP endpoint (Streamable HTTP, stateless: every request stands alone). Signs the
 * caller in from their bearer token, or answers 401 pointing at how to get one.
 */
export async function handleMcp(req: Request, authenticate: (req: Request) => Promise<Caller | null>): Promise<Response> {
  const origin = originOf(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Someone opening the address in a browser: show them how to use it.
  if (req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(null, { status: 302, headers: { ...CORS, Location: `${origin}/agents` } });
  }

  const caller = await authenticate(req);
  if (!caller) {
    const hadToken = /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "");
    const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${hadToken ? ', error="invalid_token"' : ""}`;
    return new Response(
      JSON.stringify({
        error: hadToken ? "invalid_token" : "unauthorized",
        error_description: hadToken ? "The access token is invalid or expired." : `Connect to Margin first. How: ${origin}/agents`,
      }),
      { status: 401, headers: { ...CORS, "Content-Type": "application/json", "WWW-Authenticate": challenge } },
    );
  }

  const server = new McpServer({ name: "margin", title: "Margin", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, { store: caller.store, origin });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(req));
  } finally {
    void server.close();
  }
}

/** RFC 9728: where agents find out which server signs people in for this one. */
export function protectedResource(req: Request, authServer: string): Response {
  const origin = originOf(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return new Response(
    JSON.stringify({
      resource: `${origin}/mcp`,
      authorization_servers: [authServer],
      scopes_supported: ["email"],
      bearer_methods_supported: ["header"],
      resource_name: "Margin",
      resource_documentation: `${origin}/agents`,
    }),
    { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } },
  );
}
