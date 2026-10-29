import { chromium } from "playwright";
import { createBackend, setSessionSeconds, EMAIL, PASSWORD, UID } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }

// Keys idb-keyval holds on this device (the app's local copy lives under notes:<uid>:...).
const idbKeys = (p) => p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("keyval-store");
  r.onupgradeneeded = () => r.result.createObjectStore("keyval");
  r.onsuccess = () => { const q = r.result.transaction("keyval", "readonly").objectStore("keyval").getAllKeys(); q.onsuccess = () => { res(q.result.map(String)); r.result.close(); }; };
  r.onerror = () => res([]);
}));
const mine = (keys) => keys.filter((k) => k.startsWith(`notes:${UID}:`));
const idbValue = (p, key) => p.evaluate((key) => new Promise((res) => {
  const r = indexedDB.open("keyval-store");
  r.onsuccess = () => { const q = r.result.transaction("keyval").objectStore("keyval").get(key); q.onsuccess = () => { res(q.result ?? null); r.result.close(); }; };
  r.onerror = () => res(null);
}), key);
const hasSession = (p) => p.evaluate(() => Object.keys(localStorage).some((k) => k.endsWith("-auth-token")));

async function signedIn(be, opts = {}) {
  const c = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...opts });
  await be.install(c);
  const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" }); await nav.waitFor();
  return { c, p, nav };
}
async function newPage(p, nav, be, title) {
  await nav.getByRole("button", { name: "New page" }).first().click();
  await p.getByLabel("Page title").fill(title);
  await until(() => [...be.db.values()].some((r) => r.title === title), "page synced");
  await until(async () => mine(await idbKeys(p)).includes(`notes:${UID}:pages`), "local copy saved");
  // Synced and saved locally as synced: nothing pending on this device.
  await until(async () => { const d = await idbValue(p, `notes:${UID}:dirty`); return d && Object.keys(d).length === 0; }, "no pending edits");
}
async function openSettings(p, nav) {
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByRole("menuitem", { name: "Settings" }).click();
  await p.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}
async function openDialog(p, nav) {
  await openSettings(p, nav);
  await p.getByRole("button", { name: "Delete account" }).click();
  const d = p.getByRole("dialog", { name: "Delete account" }); await d.waitFor();
  return d;
}

await step("Delete account is the last section of Settings and asks for your email first", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await openSettings(p, nav);
  const sections = await p.locator("section[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  assert(sections.at(-1) === "Delete account", "last section: " + sections.at(-1));
  await p.screenshot({ path: `${SHOTS}/110-settings-delete.png`, fullPage: true });
  await p.getByRole("button", { name: "Delete account" }).click();
  const d = p.getByRole("dialog", { name: "Delete account" });
  const del = d.getByRole("button", { name: "Delete account" });
  assert(await del.isDisabled(), "starts disabled");
  await d.getByRole("textbox").fill("me@example.co");
  assert(await del.isDisabled(), "wrong email keeps it disabled");
  await d.getByRole("textbox").fill("  ME@Example.com ");
  assert(await del.isEnabled(), "case and spaces don't matter");
  await p.screenshot({ path: `${SHOTS}/111-delete-dialog.png` });
  await p.keyboard.press("Escape");
  await until(async () => (await d.count()) === 0, "escape closes");
  await (await openDialog(p, nav)).getByRole("button", { name: "Cancel" }).click();
  await until(async () => (await d.count()) === 0, "cancel closes");
  assert(be.deleteCalls.length === 0, "nothing sent");
  await c.close();
});

await step("Export all pages from the dialog downloads everything first", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Keep me");
  const d = await openDialog(p, nav);
  const download = p.waitForEvent("download");
  await d.getByRole("button", { name: "Export all pages" }).click();
  const file = await download;
  assert(file.suggestedFilename().endsWith(".zip") || file.suggestedFilename().endsWith(".md"), "file: " + file.suggestedFilename());
  await d.getByText(/^Exported 1 page\./).waitFor();
  assert(await d.count() === 1, "dialog stays open");
  await c.close();
});

await step("deleting: sends your email, clears this device, signs out here only, shows the goodbye screen", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Diary");
  const d = await openDialog(p, nav);
  await d.getByRole("textbox").fill(" me@example.com ");
  await d.getByRole("button", { name: "Delete account" }).click();
  await p.getByRole("heading", { name: "Your account is deleted" }).waitFor();
  await p.screenshot({ path: `${SHOTS}/112-account-deleted.png` });
  assert(be.deleteCalls.length === 1 && be.deleteCalls[0].confirm === "me@example.com", "call: " + JSON.stringify(be.deleteCalls));
  assert(![...be.db.values()].some((r) => r.owner_id === UID), "server pages gone");
  assert(new URL(p.url()).pathname === "/", "url: " + p.url());
  await until(async () => mine(await idbKeys(p)).length === 0, "local copy gone: " + mine(await idbKeys(p)));
  assert(!(await hasSession(p)), "session removed from this device");
  assert(be.logouts.at(-1) === "local", "logout scope: " + be.logouts);
  await p.getByRole("link", { name: "Done" }).click();
  await p.getByRole("button", { name: "Start writing" }).first().waitFor(); // landing page
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByText("Email or password is wrong.").waitFor();
  await c.close();
});

await step("a server error leaves you signed in with your pages and says to try again", async () => {
  const be = createBackend(); be.deleteResult = { status: 500, body: { error: "failed" } };
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Still here");
  const d = await openDialog(p, nav);
  await d.getByRole("textbox").fill(EMAIL);
  await d.getByRole("button", { name: "Delete account" }).click();
  await d.getByText("Couldn't finish deleting your account. Try again.").waitFor();
  assert(await d.getByRole("button", { name: "Delete account" }).isEnabled(), "can retry");
  await d.getByRole("button", { name: "Cancel" }).click();
  await nav.getByText("Still here").first().waitFor();
  assert(mine(await idbKeys(p)).length > 0 && (await hasSession(p)), "device untouched");
  await c.close();
});

await step("offline: says so and sends nothing", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  const d = await openDialog(p, nav);
  await d.getByRole("textbox").fill(EMAIL);
  await c.setOffline(true);
  await d.getByRole("button", { name: "Delete account" }).click();
  await d.getByText("You're offline. Try again when you're back online.").waitFor();
  assert(be.deleteCalls.length === 0, "nothing sent");
  await c.close();
});

await step("another device opened after the deletion signs out and drops its copy", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Laptop page");
  be.deletedUsers.add(UID); // deleted from the phone meanwhile
  // Days later: the stored access token has expired, so opening the app needs a refresh.
  await p.evaluate(() => { const k = Object.keys(localStorage).find((k) => k.endsWith("-auth-token")); const s = JSON.parse(localStorage.getItem(k)); s.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem(k, JSON.stringify(s)); });
  await p.reload({ waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor(); // the page's link, signed out
  await until(async () => mine(await idbKeys(p)).length === 0, "local copy dropped: " + mine(await idbKeys(p)));
  await c.close();
});

await step("...but a copy holding edits that never synced stays", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Draft");
  await c.setOffline(true);
  await p.getByLabel("Page title").fill("Draft, edited offline");
  await until(async () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open("keyval-store"); r.onsuccess = () => { const q = r.result.transaction("keyval").objectStore("keyval").getAll(); q.onsuccess = () => res(JSON.stringify(q.result).includes("edited offline")); }; })), "offline edit saved locally");
  be.deletedUsers.add(UID);
  await p.evaluate(() => { const k = Object.keys(localStorage).find((k) => k.endsWith("-auth-token")); const s = JSON.parse(localStorage.getItem(k)); s.expires_at = Math.floor(Date.now() / 1000) - 60; localStorage.setItem(k, JSON.stringify(s)); });
  await c.setOffline(false);
  await p.reload({ waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor(); // the page's link, signed out
  await new Promise((r) => setTimeout(r, 800));
  assert(mine(await idbKeys(p)).includes(`notes:${UID}:dirty`), "kept: " + mine(await idbKeys(p)));
  await c.close();
});

await step("a device that's open when the account goes signs out once its access token runs out, and drops its copy", async () => {
  setSessionSeconds(60); // inside the 90 second margin, so the app refreshes on every 30 second tick
  try {
    const be = createBackend();
    const { c, p, nav } = await signedIn(be);
    await newPage(p, nav, be, "Open tab");
    const before = be.refreshes ?? 0;
    be.deletedUsers.add(UID);
    await until(() => (be.refreshes ?? 0) > before, "a refresh happens", 40000);
    // supabase-js keeps a session whose access token still works when a refresh fails, and waits
    // 60 s before retrying the same refresh token; the retry after the token expires signs out.
    await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor({ timeout: 110000 });
    await until(async () => mine(await idbKeys(p)).length === 0, "local copy dropped: " + mine(await idbKeys(p)));
    await c.close();
  } finally {
    setSessionSeconds(3600);
  }
});

await step("normal sign-out still asks before dropping unsynced edits", async () => {
  const be = createBackend();
  const { c, p, nav } = await signedIn(be);
  await newPage(p, nav, be, "Pending");
  await c.setOffline(true);
  await p.getByLabel("Page title").fill("Pending, offline");
  await new Promise((r) => setTimeout(r, 600));
  let asked = false;
  p.once("dialog", (dlg) => { asked = true; void dlg.dismiss(); });
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByRole("menuitem", { name: "Sign out" }).click();
  await until(() => asked, "confirm shown");
  await nav.waitFor();
  assert(mine(await idbKeys(p)).length > 0, "copy kept after cancel");
  await c.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
