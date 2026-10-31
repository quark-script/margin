// What this device has saved must never be older than what it has sent: pages waiting to sync win
// over the server's copy on the next start, so an older copy left here would undo the newer one.
import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID } from "./mock.mjs";
const BASE = "http://localhost:4173";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
// This device's saved copy of a page, as the app keeps it in IndexedDB.
const savedCopy = (p, id) => p.evaluate(([key, id]) => new Promise((res) => {
  const r = indexedDB.open("keyval-store");
  r.onsuccess = () => { const q = r.result.transaction("keyval").objectStore("keyval").get(key); q.onsuccess = () => res(q.result?.[id] ?? null); };
}), [`notes:${UID}:pages`, id]);

await step("a change reaches the server only once this device has saved it", async () => {
  const be = createBackend();
  const c = await b.newContext({ viewport: { width: 1280, height: 800 } }); await be.install(c);
  const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" }); await nav.waitFor();
  const from = p.url();
  await nav.getByRole("button", { name: "New page" }).first().click();
  await until(async () => p.url() !== from && (await p.getByLabel("Page title").inputValue()) === "", "the new page is open");
  const id = new URL(p.url()).pathname.split("/").pop();
  await p.getByLabel("Page title").fill("Trip");
  await until(() => be.db.get(id)?.title === "Trip", "page synced");
  await nav.getByText("Saved", { exact: true }).waitFor();
  // Each time the page goes up, what has this device saved of it at that moment?
  const seen = [];
  be.beforeUpsert = async (rows) => {
    const row = rows.find((r) => r.id === id);
    if (row) seen.push({ sent: row.title, saved: (await savedCopy(p, id))?.title });
  };
  // A change, then syncing at once from the status button, sooner than the app saves it here.
  await p.getByLabel("Page title").fill("Trip to Goa");
  await nav.getByRole("button", { name: /^(Saving|Saved)$/ }).click();
  await until(() => be.db.get(id)?.title === "Trip to Goa", "change synced");
  be.beforeUpsert = null;
  assert(seen.length && seen.every((s) => s.saved === s.sent), "sent before it was saved here: " + JSON.stringify(seen));
  await c.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗") || errs.length ? 1 : 0;
