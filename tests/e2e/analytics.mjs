import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";
const BASE = "http://localhost:4173";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const sent = (p) => p.evaluate(() => window.__va ?? []);
const leaks = (urls) => urls.filter((u) => /[?#]|@|example\.com|token|tok123|[0-9a-f]{8}-[0-9a-f]{4}-/.test(u));

await step("Vercel's script loads from /_vercel/insights; the landing page counts as /", async () => {
  const be = createBackend();
  const c = await b.newContext(); await be.install(c); const p = await c.newPage();
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  const urls = await until(async () => { const u = await sent(p); return u.length ? u : null; }, "a page view");
  assert(urls[0] === BASE + "/", "sent: " + urls);
  assert(be.insights.includes("/_vercel/insights/script.js"), "script: " + be.insights);
  await c.close();
});

await step("opening a page counts as /p/[page], never with the page id", async () => {
  const be = createBackend();
  const c = await b.newContext(); await be.install(c); const p = await c.newPage();
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" }); await nav.waitFor();
  await nav.getByRole("button", { name: "New page" }).first().click();
  await p.getByLabel("Page title").fill("Secret plans");
  const id = new URL(p.url()).pathname.split("/").pop();
  const urls = await until(async () => { const u = await sent(p); return u.includes(BASE + "/p/[page]") ? u : null; }, "page view for the page");
  assert(!urls.some((u) => u.includes(id)), "page id sent: " + urls);
  assert(!leaks(urls).length, "leaks: " + leaks(urls));
  await c.close();
});

await step("query strings and fragments never leave the browser (invitation email, sign-in tokens, old share links)", async () => {
  const be = createBackend();
  const c = await b.newContext(); await be.install(c); const p = await c.newPage();
  await p.goto(BASE + "/signup?email=rahul%40example.com&next=%2Fp%2Fabc", { waitUntil: "networkidle" });
  await until(async () => (await sent(p)).length, "signup view");
  let urls = await sent(p);
  assert(urls[0] === BASE + "/signup", "signup sent as: " + urls[0]);
  await p.goto(BASE + "/auth/confirm?token_hash=abc123&type=email", { waitUntil: "networkidle" });
  await until(async () => (await sent(p)).length, "confirm view");
  urls = await sent(p);
  // The app strips the one-time token from the address bar before anything else runs.
  assert(urls[0] === BASE + "/", "confirm link sent as: " + urls[0]);
  await p.goto(BASE + "/s/tok123/page456", { waitUntil: "networkidle" });
  await until(async () => (await sent(p)).length, "share link view");
  urls = await sent(p);
  assert(urls[0] === BASE + "/s/[link]", "share link sent as: " + urls[0]);
  await p.goto(BASE + "/#access_token=sometoken&refresh_token=x&token_type=bearer", { waitUntil: "networkidle" });
  await until(async () => (await sent(p)).length, "oauth return view");
  urls = await sent(p);
  assert(!leaks(urls).length, "leaks: " + leaks(urls));
  await c.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
