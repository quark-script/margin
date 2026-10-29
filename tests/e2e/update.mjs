import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { createBackend, EMAIL, PASSWORD, UID } from "./mock.mjs";
const BASE = "http://localhost:4173";
const APP = new URL("../..", import.meta.url).pathname;
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error("timed out: " + msg); }
// A new release: rebuilt where the test server serves it from (see tests/e2e.mjs).
const build = (env = {}) =>
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", ".e2e-dist", "--emptyOutDir", "--logLevel", "warn"], { cwd: APP, stdio: "pipe", env: { ...process.env, ...env } });

build(); // version A
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const now = () => new Date().toISOString();
for (const [id, title] of [["dddddddd-0000-4000-8000-000000000001", "First"], ["dddddddd-0000-4000-8000-000000000002", "Second"]])
  be.db.set(id, { id, owner_id: UID, parent_id: null, title, icon: null, content: [], search_text: "", position: title === "First" ? 0 : 1, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now() });
const ctx = await b.newContext(); await be.install(ctx);
const p = await ctx.newPage();
p.on("pageerror", (e) => errs.push(e.message));
const bundle = () => p.evaluate(() => document.querySelector('script[type="module"][src*="index-"]')?.getAttribute("src"));

await p.goto(BASE + "/login", { waitUntil: "networkidle" });
await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
await p.getByRole("button", { name: "Sign in" }).click();
const nav = p.getByRole("navigation", { name: "Pages" });
await nav.getByText("First").click();
await until(() => p.evaluate(() => !!navigator.serviceWorker.controller), "service worker in control");
const before = await bundle();
await p.evaluate(() => (window.__marker = "still the same page"));

await step("a new version published while the app is open is picked up, without reloading under you", async () => {
  build({ VITE_SITE_URL: "https://version-b.example" }); // version B: a different bundle
  await p.evaluate(() => window.dispatchEvent(new Event("focus"))); // coming back to the app checks for updates
  await until(() => p.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL && (await fetch("/sw.js", { cache: "no-store" })).ok), "sw reachable");
  await p.waitForTimeout(6000); // install + activate
  assert((await p.evaluate(() => window.__marker)) === "still the same page", "the page reloaded while in use");
  assert((await bundle()) === before, "bundle changed without a reload?");
});

await step("moving to another page switches to the new version", async () => {
  await nav.getByText("Second").click();
  await until(async () => (await p.evaluate(() => window.__marker).catch(() => "x")) === undefined, "page reloaded", 10000);
  await p.getByLabel("Page title").waitFor();
  const after = await bundle();
  assert(after && after !== before, `bundle should change: ${before} -> ${after}`);
  assert(new URL(p.url()).pathname === "/p/dddddddd-0000-4000-8000-000000000002", "stayed on the page you opened: " + p.url());
});

await b.close();
build(); // back to the normal build for the other suites
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
