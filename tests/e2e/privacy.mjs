import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
let page;
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { await page?.screenshot({ path: `${SHOTS}/FAIL-privacy-${n.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const be = createBackend();
be.freshDevices = true; // nothing saved by the mock: this suite switches Sync all pages off itself
const now = () => new Date().toISOString();
const seed = (id, title, text) => be.db.set(id, { id, owner_id: UID, parent_id: null, title, icon: null, content: [{ type: "paragraph", content: [{ type: "text", text }] }], search_text: text, position: 0, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now() });
const SHARED = "eeeeeeee-0000-4000-8000-000000000001", DIARY = "eeeeeeee-0000-4000-8000-000000000002", CHILD = "eeeeeeee-0000-4000-8000-000000000003";
seed(CHILD, "Plan details", "details text"); // older than its parent: arrives first
seed(SHARED, "Shared plan", "plan text");
seed(DIARY, "Private diary", "diary text");
be.db.get(CHILD).parent_id = SHARED;
be.shares.set(SHARED, { page_id: SHARED, token: "tok-shared", can_edit: false });

const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); await be.install(ctx);
page = await ctx.newPage();
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text().slice(0, 160)));
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const editor = () => page.locator("main .bn-editor").first();
const server = (title) => [...be.db.values()].find((r) => r.title === title);
async function openSettings() {
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}
// Put the cursor at the end of the first line: a click in the middle would type mid-line.
async function clickLineEnd() {
  const line = editor().locator(".bn-inline-content").first();
  const box = await line.boundingBox();
  await line.click({ position: { x: Math.max(1, box.width - 2), y: box.height / 2 } });
  await page.keyboard.press("End");
}
async function moveTo(title, target) {
  const row = sidebar().getByRole("link", { name: title }).first().locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  if (!target) return page.getByRole("option", { name: "Top level" }).click();
  await page.keyboard.type(target);
  await page.getByRole("option", { name: new RegExp("^" + target) }).first().click();
}
const idbKeys = () => page.evaluate(async () => {
  const req = indexedDB.open("keyval-store");
  const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
  return new Promise((r) => { const q = db.transaction("keyval").objectStore("keyval").getAllKeys(); q.onsuccess = () => r(q.result.map(String)); });
});
async function newPage(title) {
  const from = page.url();
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await until(async () => page.url() !== from && (await page.getByLabel("Page title").inputValue()) === "", "the new page is open");
  await page.getByLabel("Page title").fill(title);
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "cursor in body");
}

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
// Sync all pages switched off on this device. (A new device starts with it on: see further down.)
await page.evaluate((uid) => localStorage.setItem(`margin:sync:${uid}`, "shared"), UID);
await page.getByLabel("Email").fill(EMAIL); await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

await step("Sync all pages switched off on this device: only shared pages come down", async () => {
  await sidebar().getByText("Sync off").waitFor();
  await sidebar().getByRole("link", { name: "Shared plan" }).waitFor();
  await page.waitForTimeout(500);
  assert((await sidebar().getByText("Private diary").count()) === 0, "a private page came down");
  await page.getByText("Your pages stay on this device").waitFor(); // the hint on Home
  // Inside the shared page, so shared too, though it came down before its parent.
  await sidebar().getByRole("link", { name: "Shared plan" }).first().locator("..").getByRole("button", { name: "Expand" }).click();
  await sidebar().getByRole("link", { name: "Plan details" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/160-privacy-home.png` });
});

await step("a page you share syncs; a new private page stays here", async () => {
  await sidebar().getByRole("link", { name: "Shared plan" }).click();
  await clickLineEnd();
  await page.keyboard.type(" updated");
  await until(() => server("Shared plan").search_text.includes("plan text updated"), "shared edit reached the server");
  await newPage("Secret");
  await page.keyboard.type("only mine");
  await page.waitForTimeout(2500);
  assert(!server("Secret"), "a private page reached the server");
});

await step("an image in a private page stays on this device", async () => {
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await page.getByRole("option", { name: /^Image/ }).first().click();
  await page.locator(".bn-panel").getByText("Upload image").waitFor();
  await page.waitForTimeout(200);
  await page.locator(".bn-panel input[type=file]").first().setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  const img = editor().locator("img").first();
  await img.waitFor();
  // The address resolves from this device's storage a moment after the image appears.
  await until(async () => (await img.getAttribute("src"))?.startsWith("blob:"), "not kept on the device: " + (await img.getAttribute("src")));
  assert(be.objects.size === 0, "uploaded");
});

await step("no version history for a page that doesn't sync; there is for a shared one", async () => {
  const menuFor = async (title) => {
    const row = sidebar().getByRole("link", { name: title }).first().locator(".."); // shared pages carry a marker in their name
    await row.hover();
    await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).waitFor();
    const has = (await page.getByRole("menuitem", { name: "Version history" }).count()) > 0;
    await page.keyboard.press("Escape");
    return has;
  };
  assert(!(await menuFor("Secret")), "history offered for a private page");
  assert(await menuFor("Shared plan"), "no history for a shared page");
});

await step("sharing a page that's only on this device syncs it first, image included", async () => {
  await sidebar().getByRole("link", { name: "Secret" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByText("This page is only on this device.").waitFor();
  await page.screenshot({ path: `${SHOTS}/161-privacy-share-first.png` });
  await page.getByRole("button", { name: "Sync and share" }).click();
  await page.getByLabel("Email to invite").waitFor();
  const row = server("Secret");
  assert(row, "not synced");
  assert(JSON.stringify(row.content).includes("notes-media:"), "image address not uploaded: " + JSON.stringify(row.content).slice(0, 160));
  assert(be.objects.size === 1, "image not uploaded");
  await page.getByLabel("Email to invite").fill("friend@example.com");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await until(() => be.members.some((m) => m.page_id === row.id), "invited");
  await page.keyboard.press("Escape");
  await clickLineEnd();
  await page.keyboard.type(" and shared");
  await until(() => server("Secret").search_text.includes("only mine and shared"), "a shared page keeps syncing");
});

await step("signing out warns that pages only on this device would be deleted", async () => {
  await newPage("Draft");
  await page.keyboard.type("not synced");
  await page.waitForTimeout(800);
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await until(() => asked, "no warning");
  assert(asked.includes("exist only on this device"), "warning: " + asked);
  await sidebar().waitFor(); // still signed in
});

await step("moving a page out of a shared page tells the server, so it isn't shared there any more", async () => {
  await moveTo("Plan details", null);
  await until(() => server("Plan details").parent_id === null, "move reached the server");
});

await step("moving a shared page into a page only on this device takes that page up too, unshared", async () => {
  await newPage("Folder");
  await page.keyboard.type("folder text");
  await page.waitForTimeout(1500);
  assert(!server("Folder"), "a private page went up early");
  await moveTo("Secret", "Folder");
  await until(() => server("Folder") && server("Secret").parent_id === server("Folder").id, "move reached the server", 15000);
  const folder = server("Folder").id;
  assert(!be.shares.has(folder) && !be.members.some((m) => m.page_id === folder), "the containing page got shared");
});

await step("Sync all pages on: everything goes up and everything comes down", async () => {
  await openSettings();
  const sw = page.getByRole("switch", { name: "Sync all pages" });
  assert((await sw.getAttribute("aria-checked")) === "false", "should start off");
  await page.screenshot({ path: `${SHOTS}/162-privacy-settings.png` });
  await sw.click();
  await until(() => server("Draft"), "private page went up");
  await sidebar().getByRole("link", { name: "Private diary" }).waitFor();
  await sidebar().getByText("Saved").waitFor();
});

await step("nothing saved on a device: Sync all pages is on; switched off in an older version: it stays off", async () => {
  const key = `margin:sync:${UID}`;
  await page.evaluate((k) => localStorage.removeItem(k), key);
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByText("Saved").waitFor();
  await openSettings();
  assert((await page.getByRole("switch", { name: "Sync all pages" }).getAttribute("aria-checked")) === "true", "a device with nothing saved should sync everything");
  await page.evaluate(([k, uid]) => { localStorage.removeItem(k); localStorage.setItem(`margin:sync-off:${uid}`, "1"); }, [key, UID]);
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByText("Sync off").waitFor();
  assert((await page.evaluate((k) => localStorage.getItem(k), key)) === "shared", "the older choice was lost");
  // On again for the steps after this one.
  await page.evaluate((k) => localStorage.setItem(k, "all"), key);
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByText("Saved").waitFor();
});

await step("signing out removes this account's pages and images from the device", async () => {
  assert((await idbKeys()).some((k) => k.startsWith("media:local:")), "test setup: an image kept on the device");
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).first().waitFor();
  const left = async () => (await idbKeys()).filter((k) => k.startsWith("media:local:") || k.startsWith(`notes:${UID}:`));
  await until(async () => (await left()).length === 0, "device copy removed").catch(async (e) => { throw new Error(e.message + ": " + (await left()).join(", ")); });
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
