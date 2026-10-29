// The MCP server end to end: the MCP SDK's own client, over HTTP, against handleMcp, with an
// in-memory Store standing in for Supabase (the same contract as api/_lib/store.ts). npm runs it
// with require() of ES modules switched off, as it effectively is on Vercel.
import http from "node:http";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
// Bundled into node_modules, so its packages resolve from there as they do on Vercel.
const bundle = new URL("../node_modules/.cache/mcp-test/server.mjs", import.meta.url).pathname;
await build({
  entryPoints: [new URL("../api/_lib/server.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: bundle,
  logLevel: "warning",
});
const { handleMcp, protectedResource } = await import(bundle);

const results = [];
const step = async (name, fn) => { try { await fn(); results.push(["✓", name]); } catch (e) { results.push(["✗", name, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---- in-memory store ----
const now = () => new Date().toISOString();
const pages = new Map();
const seals = [];
let quota = null; // set to force a limit answer
let editing = null;
const tick = (() => { let t = Date.parse("2026-10-29T10:00:00Z"); return () => new Date((t += 1000)).toISOString(); })();
function add(id, title, extra = {}) { const ts = tick(); pages.set(id, { id, parent_id: null, title, icon: null, position: 0, is_archived: false, created_at: ts, updated_at: ts, content: [], ...extra }); }
const P = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
add(P(1), "Projects", { icon: "📁", position: 0 });
add(P(2), "Launch plan", { parent_id: P(1), position: 0, content: [
  { id: "b1", type: "paragraph", content: [{ type: "text", text: "Ship it on Friday. See ", styles: {} }, { type: "pageLink", props: { pageId: P(3) } }] },
  { id: "b2", type: "image", props: { url: "notes-media:user/cat.png", caption: "", name: "cat.png" } },
  { id: "b3", type: "file", props: { url: "notes-media:user/spec.pdf", name: "spec.pdf" } },
  { id: "b4", type: "paragraph", content: [] },
] });
add(P(3), "Budget", { position: 1 });
add(P(4), "Old stuff", { position: 2, is_archived: true });
add(P(5), "Inside old", { parent_id: P(4) });
const store = {
  async take(write) { return quota ?? { ok: true }; },
  async tree() { return [...pages.values()].map(({ content, ...p }) => p); },
  async page(id) { const p = pages.get(id); return p ? structuredClone(p) : null; },
  async search(q, limit) {
    const n = q.toLowerCase();
    return [...pages.values()].filter((p) => !p.is_archived && (p.title.toLowerCase().includes(n) || JSON.stringify(p.content).toLowerCase().includes(n)))
      .slice(0, limit).map((p) => ({ id: p.id, title: p.title, icon: p.icon, parent_id: p.parent_id, updated_at: p.updated_at, snippet: "…" + n + "…" }));
  },
  async insertPage(p) { const ts = tick(); pages.set(p.id, { ...p, is_archived: false, created_at: ts, updated_at: ts }); return { updated_at: ts }; },
  async updatePage(id, patch) { const ts = tick(); Object.assign(pages.get(id), patch, { updated_at: ts }); return { updated_at: ts }; },
  async seal(id) { seals.push(id); },
  async editingNow() { return editing; },
  async fileLink(path) { return `https://test.supabase.co/storage/v1/object/sign/notes-media/${path}?token=t`; },
};
const auth = async (req) => (req.headers.get("authorization") === "Bearer good" ? { userId: "u1", store } : null);

// ---- HTTP server around the Web handlers ----
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = `http://localhost:${srv.address().port}${req.url}`;
  const body = ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(chunks);
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const response = req.url.startsWith("/.well-known/") ? protectedResource(request, "https://test.supabase.co/auth/v1") : await handleMcp(request, auth);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;

await step("without a token: 401 pointing at the resource metadata", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert(r.status === 401, "status " + r.status);
  const h = r.headers.get("www-authenticate");
  assert(h === `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, "header: " + h);
  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
  assert(bad.status === 401 && bad.headers.get("www-authenticate").includes('error="invalid_token"'), "invalid token");
  assert(bad.headers.get("access-control-allow-origin") === "*", "cors");
});

await step("resource metadata names Supabase Auth and the guide", async () => {
  const j = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert(j.resource === `${base}/mcp` && j.authorization_servers[0] === "https://test.supabase.co/auth/v1", JSON.stringify(j));
  assert(j.resource_documentation === `${base}/agents` && j.scopes_supported.join() === "email", JSON.stringify(j));
});

await step("a browser opening /mcp goes to the guide", async () => {
  const r = await fetch(`${base}/mcp`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert(r.status === 302 && r.headers.get("location") === `${base}/agents`, r.status + " " + r.headers.get("location"));
});

const client = new Client({ name: "test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer good" } } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), error: Boolean(r.isError) };
};

await step("connects: Margin's name, instructions and eight tools", async () => {
  assert(client.getServerVersion().name === "margin", JSON.stringify(client.getServerVersion()));
  assert(client.getInstructions().includes("[[Page title]]"), "instructions");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort().join(",");
  assert(names === "append_to_page,create_page,daily_note,list_pages,read_page,recent_pages,search_pages,update_page", names);
  assert(tools.find((t) => t.name === "read_page").annotations.readOnlyHint === true, "read only hint");
  assert(tools.find((t) => t.name === "update_page").annotations.destructiveHint === true, "destructive hint");
});

await step("read_page: details, page links as Margin links, stored files as week-long links", async () => {
  const r = await call("read_page", { page: `https://margin.dhanpulse.in/p/${P(2)}` });
  assert(!r.error, r.text);
  for (const s of ["Title: Launch plan", `Page id: ${P(2)}`, `Link: ${base}/p/${P(2)}`, "Location: Projects › Launch plan", "Content (Markdown):", `[Budget](${base}/p/${P(3)})`, "https://test.supabase.co/storage/v1/object/sign/notes-media/user/cat.png?token=t", "[spec.pdf](https://test.supabase.co/storage/v1/object/sign/notes-media/user/spec.pdf?token=t)"]) {
    assert(r.text.includes(s), "missing " + JSON.stringify(s) + " in\n" + r.text);
  }
});

await step("update_page with the read content back: page link, image and file come back as they were", async () => {
  const read = (await call("read_page", { page: P(2) })).text;
  const md = read.split("Content (Markdown):\n\n")[1];
  seals.length = 0;
  const r = await call("update_page", { page: P(2), content: md + "\n\nOne more line." });
  assert(!r.error, r.text);
  const c = pages.get(P(2)).content;
  const types = c.map((b) => b.type).join(",");
  assert(types.startsWith("paragraph,image,file") && types.endsWith("paragraph"), "types: " + types);
  assert(JSON.stringify(c[0].content).includes(`"pageLink","props":{"pageId":"${P(3)}"}`), "page link: " + JSON.stringify(c[0].content));
  assert(c[1].props.url === "notes-media:user/cat.png", "image: " + c[1].props.url);
  assert(c[2].props.url === "notes-media:user/spec.pdf" && c[2].props.name === "spec.pdf", "file: " + JSON.stringify(c[2].props));
  assert(pages.get(P(2)).search_text.includes("One more line"), "search text");
  assert(seals.length === 2 && seals.every((s) => s === P(2)), "sealed before and after: " + seals);
  assert(r.text.includes("previous version is in its version history"), r.text);
});

await step("create_page inside a page, with [[links]] (known and unknown) and an emoji icon", async () => {
  seals.length = 0;
  const r = await call("create_page", { title: "Meeting notes", parent: P(1), icon: "📝", content: "Talked about [[budget]] and [[Nowhere page]].\n\n- [ ] follow up" });
  assert(!r.error, r.text);
  const id = /Page id: (\S+)/.exec(r.text)[1];
  const p = pages.get(id);
  assert(p.parent_id === P(1) && p.icon === "📝" && p.position === 1, JSON.stringify({ parent: p.parent_id, icon: p.icon, pos: p.position }));
  const inline = JSON.stringify(p.content[0].content);
  assert(inline.includes(`"pageId":"${P(3)}"`) && inline.includes("Nowhere page") && !inline.includes("page.margin.invalid"), inline);
  assert(p.content[1].type === "checkListItem", p.content[1].type);
  assert(seals.join() === id, "sealed after: " + seals);
});

await step("append_to_page keeps what's there and drops the empty line at the end first", async () => {
  pages.get(P(3)).content = [{ id: "x", type: "paragraph", content: [{ type: "text", text: "Q1", styles: {} }] }, { id: "y", type: "paragraph", content: [] }];
  const r = await call("append_to_page", { page: P(3), content: "Q2" });
  assert(!r.error, r.text);
  const texts = pages.get(P(3)).content.map((b) => (b.content ?? []).map((t) => t.text).join(""));
  assert(texts.join("|") === "Q1|Q2", texts.join("|"));
});

await step("search, recent and list show ids and where pages are; the trash stays out", async () => {
  const s = await call("search_pages", { query: "budget" });
  assert(!s.error && s.text.includes(`(id: ${P(3)})`) && s.text.includes("top level"), s.text);
  const none = await call("search_pages", { query: "inside old" });
  assert(none.text.startsWith("No pages match"), none.text);
  const recent = await call("recent_pages", { limit: 3 });
  assert(recent.text.split("\n").length === 4 && !recent.text.includes("Old stuff"), recent.text);
  const top = await call("list_pages", {});
  assert(top.text.includes("📁 Projects") && top.text.includes("2 pages inside") && !top.text.includes("Old stuff"), top.text);
  const inside = await call("list_pages", { parent: P(1) });
  assert(inside.text.startsWith('Pages inside "Projects"') && inside.text.indexOf("Launch plan") < inside.text.indexOf("Meeting notes"), inside.text);
});

await step("pages in the trash, unknown pages and someone else editing give clear answers", async () => {
  const t = await call("read_page", { page: P(5) });
  assert(t.error && t.text.includes("is in the trash"), t.text);
  const u = await call("read_page", { page: "bbbbbbbb-0000-4000-8000-000000000000" });
  assert(u.error && u.text.includes("Use search_pages or list_pages"), u.text);
  editing = "Asha";
  const e = await call("append_to_page", { page: P(3), content: "x" });
  editing = null;
  assert(e.error && e.text === 'Asha is editing "Budget" in Margin right now. Try again in a minute.', e.text);
});

await step("limits: a refused call says which limit and when to retry", async () => {
  quota = { ok: false, limit: "minute", retry_after: 12 };
  const m = await call("create_page", { title: "x" });
  quota = { ok: false, limit: "day", retry_after: 7200 };
  const d = await call("read_page", { page: P(3) });
  quota = null;
  assert(m.error && m.text === "Margin allows agents 30 changes a minute, and that's used up. Try again in 12 seconds.", m.text);
  assert(d.error && d.text.includes("3000 reads a day") && d.text.includes("about 2 hours"), d.text);
});

await step("bad input is refused with the reason", async () => {
  const icon = await call("create_page", { title: "x", icon: "abc" });
  assert(icon.error && icon.text.includes("The icon must be an emoji."), icon.text);
  const big = await call("append_to_page", { page: P(3), content: "x".repeat(100_001) });
  assert(big.error && big.text.includes("up to 100,000 characters"), big.text);
  const nothing = await call("update_page", { page: P(3) });
  assert(nothing.error && nothing.text.startsWith("Nothing to change"), nothing.text);
  const date = await call("daily_note", { date: "2026-02-30" });
  assert(date.error && date.text.includes("doesn't exist"), date.text);
});

await step("daily_note: missing day says so; adding creates Daily notes and the day; adding again appends", async () => {
  const before = pages.size;
  const empty = await call("daily_note", { date: "2026-10-29" });
  assert(!empty.error && empty.text.startsWith("There's no daily note for 2026-10-29 yet"), empty.text);
  assert(pages.size === before, "created on read");
  const first = await call("daily_note", { date: "2026-10-29", append: "Called the bank." });
  assert(!first.error && first.text.startsWith("Started the daily note for 2026-10-29"), first.text);
  const parent = [...pages.values()].find((p) => p.title === "Daily notes");
  const day = [...pages.values()].find((p) => p.title === "2026-10-29");
  assert(parent && parent.icon === "📅" && day.parent_id === parent.id, "pages");
  await call("daily_note", { date: "2026-10-29", append: "Paid rent." });
  const read = await call("daily_note", { date: "2026-10-29" });
  assert(read.text.includes("Called the bank.") && read.text.includes("Paid rent.") && read.text.includes("Location: Daily notes › 2026-10-29"), read.text);
  assert([...pages.values()].filter((p) => p.title === "Daily notes").length === 1, "one Daily notes page");
});

await client.close();
srv.close();
for (const r of results) console.log(r.join(" "));
const passed = results.every((r) => r[0] === "✓");
console.log(passed ? "All passed." : "Failed.");
process.exit(passed ? 0 : 1);
