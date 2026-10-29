import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
let page;
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { await page?.screenshot({ path: `${SHOTS}/FAIL-local-${n.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const be = createBackend();
be.freshDevices = true; // no saved sync choice: signing in from here has to turn it on by itself
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); await be.install(ctx);
page = await ctx.newPage();
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text().slice(0, 160)));
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const notice = () => page.getByRole("status");
const editor = () => page.locator("main .bn-editor").first();
const restCalls = () => be.log.filter((l) => /\/rest\/v1\/pages/.test(typeof l === "string" ? l : JSON.stringify(l))).length;
async function openSettings() {
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}

await step("from the landing page, Start writing opens Margin without an account", async () => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByText("Private by default. Your notes stay on your device and sync only if you want them to.").waitFor();
  await page.getByRole("button", { name: "Start writing" }).first().click();
  await sidebar().waitFor();
  await sidebar().getByText("On this device").waitFor();
  const strip = page.getByRole("note").filter({ hasText: "Your pages are saved on this device only." });
  await strip.getByText("To sync across devices and keep a backup", { exact: false }).waitFor();
  assert((await strip.getByRole("link", { name: "create an account" }).getAttribute("href")) === "/signup", "create link");
  assert((await strip.getByRole("link", { name: "sign in" }).getAttribute("href")) === "/login", "sign in link");
  await page.screenshot({ path: `${SHOTS}/151-local-strip.png` });
});

await step("pages are kept in this browser: create one, reload, still there; nothing sent", async () => {
  const before = restCalls();
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Groceries");
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "cursor in body");
  await page.keyboard.type("milk and eggs");
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByRole("link", { name: "Groceries" }).click();
  await editor().getByText("milk and eggs").waitFor();
  assert(be.db.size === 0, "a page reached the server");
  assert(restCalls() === before, "pages were requested from the server");
});

await step("images are kept in this browser too", async () => {
  await editor().locator(".bn-inline-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await page.getByRole("option", { name: /^Image/ }).first().click();
  await page.locator(".bn-panel input[type=file]").first().waitFor({ state: "attached" });
  await page.locator(".bn-panel").getByText("Upload image").waitFor();
  await page.waitForTimeout(200);
  await page.locator(".bn-panel input[type=file]").first().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  const img = editor().locator("img").first();
  await img.waitFor();
  // The address resolves from this device's storage a moment after the image appears.
  await until(async () => (await img.getAttribute("src"))?.startsWith("blob:"), "image src: " + (await img.getAttribute("src")));
  assert(be.objects.size === 0, "an image was uploaded");
});

await step("no Share button or version history without an account", async () => {
  assert((await page.getByRole("button", { name: "Share", exact: true }).count()) === 0, "Share shown");
  const row = sidebar().getByRole("link", { name: "Groceries", exact: true }).first().locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).waitFor();
  assert((await page.getByRole("menuitem", { name: "Version history" }).count()) === 0, "history offered");
  await page.keyboard.press("Escape");
});

await step("Settings explains where the pages are, without account-only sections", async () => {
  await openSettings();
  await page.getByText("You're using Margin without an account.", { exact: false }).waitFor();
  for (const gone of ["Storage", "Sync"]) assert((await page.getByRole("region", { name: gone }).count()) === 0, gone + " shown");
  await page.getByRole("button", { name: "Delete everything" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/150-settings-local.png` });
});

await step("signing in from the strip backs this device's pages and images up, and turns sync on", async () => {
  await page.getByRole("note").getByRole("link", { name: "sign in" }).click();
  await page.getByText("The pages on this device will sync to your account, so they're backed up.").waitFor();
  await page.getByLabel("Email").fill(EMAIL); await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await notice().filter({ hasText: "1 page from this device now syncs with your account." }).waitFor({ timeout: 10000 });
  assert((await page.getByText("Your pages are saved on this device only.").count()) === 0, "strip still shown when signed in");
  const row = await until(() => [...be.db.values()].find((r) => r.title === "Groceries"), "page on the server");
  assert(row.owner_id === UID, "owner: " + row.owner_id);
  await until(() => be.objects.size === 1, "image uploaded");
  const content = JSON.stringify([...be.db.values()].find((r) => r.title === "Groceries").content);
  assert(content.includes("notes-media:") && !content.includes("local-media:"), "image address not moved: " + content.slice(0, 200));
  const left = await page.evaluate(async () => {
    const req = indexedDB.open("keyval-store");
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const keys = await new Promise((r) => { const q = db.transaction("keyval").objectStore("keyval").getAllKeys(); q.onsuccess = () => r(q.result); });
    const files = await Promise.all(keys.filter((k) => String(k).startsWith("media:local:")).map((k) => new Promise((r) => { const q = db.transaction("keyval").objectStore("keyval").get(k); q.onsuccess = () => r(q.result); })));
    // Pages move into the account; images stay as this device's copy, marked as uploaded.
    return [...keys.filter((k) => String(k).startsWith("notes:local:")), ...files.filter((f) => !String(f?.remote).startsWith("notes-media:")).map((f) => "not uploaded: " + f?.name)];
  });
  assert(left.length === 0, "left on the device: " + left.join(", "));
  await sidebar().getByText("Saved").waitFor();
});

await step("Sync off: edits stay on this device; on again: they go up", async () => {
  await openSettings();
  const sw = page.getByRole("switch", { name: "Sync all pages" });
  assert((await sw.getAttribute("aria-checked")) === "true", "sync should start on");
  await sw.click();
  await sidebar().getByText("Sync off").waitFor();
  await sidebar().getByRole("link", { name: "Groceries" }).click();
  await editor().locator(".bn-inline-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and bread");
  await page.waitForTimeout(2500);
  const server = () => JSON.stringify([...be.db.values()].find((r) => r.title === "Groceries").content);
  assert(!server().includes("and bread"), "edit reached the server with sync off");
  await sidebar().getByText("Sync off").waitFor();
  await openSettings();
  await page.getByText(/1 page not synced/).waitFor();
  await page.getByRole("switch", { name: "Sync all pages" }).click();
  await until(() => server().includes("and bread"), "edit synced after turning sync on");
  await sidebar().getByText("Saved").waitFor();
});

await step("the choice is kept for this device", async () => {
  await page.getByRole("switch", { name: "Sync all pages" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByText("Sync off").waitFor();
  await openSettings();
  await page.getByRole("switch", { name: "Sync all pages" }).click();
  await sidebar().getByText("Saved").waitFor();
});

await step("without an account, Delete everything clears this device and goes back to the start", async () => {
  const be2 = createBackend();
  const c2 = await b.newContext({ viewport: { width: 1280, height: 860 } }); await be2.install(c2);
  page = await c2.newPage();
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Start writing" }).first().click();
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Scratch");
  await page.waitForTimeout(600);
  await openSettings();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete everything" }).click();
  await page.getByRole("button", { name: "Start writing" }).first().waitFor();
  await page.getByRole("button", { name: "Start writing" }).first().click();
  await sidebar().waitFor();
  assert((await sidebar().getByText("Scratch").count()) === 0, "page survived");
  await c2.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
