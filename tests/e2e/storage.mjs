import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { await page.screenshot({ path: `${SHOTS}/FAIL-storage-${n.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const be = createBackend();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }); await be.install(ctx);
const page = await ctx.newPage();
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text()) && errs.push(m.text().slice(0, 160)));
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const notice = () => page.getByRole("status");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const byTitle = (t) => [...be.db.values()].find((p) => p.title === t);

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(EMAIL); await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

async function newImageBlock() {
  await page.locator("main .bn-editor").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await page.getByRole("option", { name: /^Image/ }).first().click();
  await page.locator(".bn-panel input[type=file]").first().waitFor({ state: "attached" });
}
// A failed upload resets the block to "Add image" and closes the panel: click it to try again.
async function pick(name, buffer, mimeType = "image/png") {
  const input = page.locator(".bn-panel input[type=file]").first();
  if (!(await input.count())) {
    await page.locator("main .bn-add-file-button").last().click();
    await input.waitFor({ state: "attached", timeout: 5000 }).catch(() => { throw new Error("file panel didn't open"); });
  }
  await page.locator(".bn-panel").getByText("Upload image").waitFor();
  await page.waitForTimeout(200); // the panel settles before it takes a file
  await input.setInputFiles({ name, mimeType, buffer });
}

await step("a file over 10 MB is refused with the reason, and nothing is uploaded", async () => {
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Photos");
  await page.getByLabel("Page title").press("Enter");
  await until(() => byTitle("Photos"), "page synced");
  await newImageBlock();
  await pick("huge.png", Buffer.alloc(11 * 1024 * 1024 + 5));
  await notice().filter({ hasText: "This file is 11 MB. Files can be up to 10 MB." }).waitFor();
  assert(be.uploads.length === 0, "uploaded anyway: " + be.uploads.length);
  // Not stuck on "Loading..." (BlockNote's own behavior after a failed upload).
  await page.locator("main .bn-add-file-button").last().waitFor();
  assert((await page.locator("main .bn-file-loading-preview").count()) === 0, "still says Loading...");
  await page.locator(".bn-panel").waitFor({ state: "detached" }); // the panel of the failed block closes
});

await step("a file type the storage doesn't take is refused with the reason", async () => {
  await pick("notes.docx", Buffer.from("x"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await notice().filter({ hasText: "Margin can store images (PNG, JPEG, WebP, GIF, SVG) and PDFs." }).waitFor({ timeout: 5000 }).catch(async () => { throw new Error("notice: " + JSON.stringify(await notice().allInnerTexts())); });
  assert(be.uploads.length === 0, "uploaded anyway");
  await page.locator(".bn-panel").waitFor({ state: "detached" });
});

await step("a normal image uploads and lands in the page", async () => {
  await pick("dot.png", PNG);
  await until(() => be.objects.size === 1, "stored");
  await until(() => JSON.stringify(byTitle("Photos").content).includes("notes-media:"), "page references it");
});

await step("with the account full, an upload is refused and points to Settings", async () => {
  be.extraUsage = 100 * 1024 * 1024;
  await newImageBlock();
  await pick("second.png", PNG);
  await notice().filter({ hasText: "Your storage is full (100 MB). Settings > Storage can free up space." }).waitFor({ timeout: 5000 }).catch(async () => { throw new Error("notice: " + JSON.stringify(await notice().allInnerTexts())); });
  assert(be.objects.size === 1, "a second file was stored");
  be.extraUsage = 0;
  await page.locator(".bn-panel").waitFor({ state: "detached" });
});

async function openSettings() {
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}

await step("Settings shows what's used; a file still in a page isn't offered for deletion", async () => {
  be.unusedAfterMs = 0;
  await openSettings();
  const storage = page.getByRole("region", { name: "Storage" });
  await storage.getByText(/KB of 100 MB used\. Each file can be up to 10 MB\./).waitFor();
  await storage.getByRole("progressbar", { name: "Storage used" }).waitFor();
  await storage.getByText("Every file you've added is in a page.").waitFor();
  assert((await storage.getByRole("button", { name: "Delete unused files" }).count()) === 0, "offered with nothing unused");
});

await step("a file no page uses any more can be deleted from Settings", async () => {
  // An image that was in a page once, then removed from it.
  be.objects.set(`notes-media/${[...be.db.values()][0].owner_id}/old.png`, { bytes: Buffer.alloc(2048), type: "image/png", at: Date.now() - 1000 });
  await until(async () => (await page.getByText("Saved", { exact: true }).count()) > 0, "synced before reload");
  await page.reload({ waitUntil: "networkidle" });
  const storage = page.getByRole("region", { name: "Storage" });
  await storage.getByText("1 file (2 KB) no longer in any page, or in the Trash.").waitFor();
  await page.screenshot({ path: `${SHOTS}/130-settings-storage.png` });
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.accept(); });
  await storage.getByRole("button", { name: "Delete unused files" }).click();
  await notice().filter({ hasText: "Deleted 1 unused file (2 KB)." }).waitFor();
  assert(asked.includes("version history"), "warning: " + asked);
  assert(![...be.objects.keys()].some((k) => k.endsWith("/old.png")), "not deleted");
  assert(be.objects.size === 1, "the image in use was deleted too");
  await storage.getByText("Every file you've added is in a page.").waitFor();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
