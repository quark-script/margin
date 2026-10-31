// What search engines and link previews get: the public pages built into the HTML with their own
// titles, descriptions and previews, robots.txt and the sitemap. And in the browser, the app taking
// over from them without showing them where it shows something else.
import { chromium } from "playwright";
import { createBackend } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SITE = "https://margin.example.com"; // VITE_SITE_URL of the test build
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const raw = async (path) => { const res = await fetch(BASE + path); assert(res.ok, `${path}: ${res.status}`); return res.text(); };
const meta = (html, key, name) => html.match(new RegExp(`<meta ${key}="${name}" content="([^"]*)"`))?.[1];
const built = (html) => html.slice(html.indexOf('<div id="prerendered">'), html.indexOf('<div id="root">'));
// A browser without the app's scripts: what a first visit shows before they load.
async function withoutScripts() {
  const c = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await c.route("**/assets/*.js", (r) => r.abort());
  return { c, p: await c.newPage() };
}

await step("the landing page is in the HTML, with its title, description, link preview and site name", async () => {
  const html = await raw("/");
  assert(html.includes("<title>Margin: a private notes app that works offline</title>"), "title");
  assert(meta(html, "name", "description")?.startsWith("A quiet place for your notes."), "description");
  assert(html.includes(`<link rel="canonical" href="${SITE}/" />`), "canonical");
  assert(meta(html, "property", "og:image") === `${SITE}/og.png`, "preview image");
  assert(meta(html, "name", "twitter:card") === "summary_large_image", "large preview");
  const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert(data["@graph"].some((n) => n["@type"] === "WebSite" && n.name === "Margin" && n.url === `${SITE}/`), "site name");
  const page = built(html);
  for (const text of ["A quiet place", "Private by default", "Start writing", "Open source on GitHub"]) assert(page.includes(text), "missing: " + text);
});

await step("the privacy policy and the AI agents guide have their own HTML, title and address", async () => {
  const privacy = await raw("/privacy");
  assert(privacy.includes("<title>Privacy policy · Margin</title>"), "privacy title");
  assert(privacy.includes(`<link rel="canonical" href="${SITE}/privacy" />`), "privacy canonical");
  assert(built(privacy).includes("Last updated"), "privacy content");
  const agents = await raw("/agents");
  assert(agents.includes(`<link rel="canonical" href="${SITE}/agents" />`), "agents canonical");
  assert(built(agents).includes(`${SITE}/mcp`), "the address for AI apps is the site's");
});

await step("robots.txt and the sitemap point at the site", async () => {
  const robots = await raw("/robots.txt");
  assert(robots.includes(`Sitemap: ${SITE}/sitemap.xml`) && robots.includes("Disallow: /api/"), "robots.txt: " + robots);
  const sitemap = await raw("/sitemap.xml");
  for (const path of ["/", "/agents", "/privacy"]) assert(sitemap.includes(`<loc>${SITE}${path}</loc>`), "sitemap: " + path);
});

await step("before the app loads, a first visit sees the page; then the app draws it, once", async () => {
  const { c, p } = await withoutScripts();
  for (const [path, heading] of [["/", /A quiet place/], ["/privacy", "Privacy"], ["/agents", "Use Margin with AI agents"]]) {
    await p.goto(BASE + path);
    assert(await p.getByRole("heading", { name: heading, level: 1 }).isVisible(), "not shown before the app: " + path);
  }
  await c.close();
  const be = createBackend();
  const c2 = await b.newContext({ viewport: { width: 1280, height: 800 } }); await be.install(c2);
  const p2 = await c2.newPage();
  p2.on("pageerror", (e) => errs.push(e.message));
  p2.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text().slice(0, 160)));
  for (const [path, heading] of [["/", /A quiet place/], ["/privacy", "Privacy"], ["/agents", "Use Margin with AI agents"]]) {
    await p2.goto(BASE + path, { waitUntil: "networkidle" });
    await p2.getByRole("heading", { name: heading, level: 1 }).waitFor();
    assert((await p2.locator("#prerendered").count()) === 0, "built copy left behind: " + path);
    assert((await p2.getByRole("heading", { name: heading, level: 1 }).count()) === 1, "two copies: " + path);
  }
  // The app's own page, not the built one: the address for AI apps is this site's.
  await p2.getByText(`${BASE}/mcp`).first().waitFor();
  await c2.close();
});

await step("where the app shows something else, the landing page doesn't flash first", async () => {
  const { c, p } = await withoutScripts();
  const shown = () => p.locator("#prerendered").isVisible();
  await p.goto(BASE + "/p/00000000-0000-4000-8000-000000000000"); // any other address gets the same file
  assert(!(await shown()), "another address");
  await p.goto(BASE + "/?ref=somewhere");
  assert(!(await shown()), "with a query");
  await p.evaluate(() => localStorage.setItem("sb-test-auth-token", "{}"));
  await p.goto(BASE + "/");
  assert(!(await shown()), "signed in");
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("margin:local", "1"); });
  await p.goto(BASE + "/");
  assert(!(await shown()), "using Margin without an account");
  await p.evaluate(() => localStorage.clear());
  await p.goto(BASE + "/");
  assert(await shown(), "signed out, on the landing page, it shows");
  await c.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗") || errs.length ? 1 : 0;
