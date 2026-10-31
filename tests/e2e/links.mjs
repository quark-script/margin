import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";

const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const results = [];
const errors = [];
let current = "";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await be.install(context);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`[${current}] pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`[${current}] console: ${m.text().slice(0, 200)}`));

async function step(name, fn) {
  current = name;
  const t = Date.now();
  try { await fn(); results.push(["PASS", name, Date.now() - t]); }
  catch (e) {
    await page.screenshot({ path: `${SHOTS}/FAIL-links-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {});
    results.push(["FAIL", name, Date.now() - t, String(e?.message ?? e).split("\n")[0]]);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("timed out: " + msg);
}
const byTitle = (t) => [...be.db.values()].find((p) => p.title === t);
const links = (p) => JSON.stringify(p?.content ?? []).match(/"pageLink","props":\{"pageId":"[^"]+"/g)?.length ?? 0;
const linksTo = (p, id) => JSON.stringify(p?.content ?? []).includes(`"pageId":"${id}"`);
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const editor = () => page.locator(".bn-editor[contenteditable=true]").first();
const menu = () => page.locator(".bn-suggestion-menu");

async function newPage(title) {
  const from = page.url();
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await until(async () => page.url() !== from && (await page.getByLabel("Page title").inputValue()) === "", "the new page is open");
  await page.getByLabel("Page title").fill(title);
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "cursor in body");
}

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(EMAIL);
await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

await step("setup: target page exists", async () => {
  await newPage("Project Alpha");
  await page.keyboard.type("Alpha details");
  await until(() => byTitle("Project Alpha")?.search_text.includes("Alpha details"), "target synced");
});

await step("[[ opens page picker filtered by query", async () => {
  await newPage("Meeting notes");
  await page.keyboard.type("Discussed ");
  await page.keyboard.type("[[");
  await menu().waitFor({ timeout: 3000 });
  await page.keyboard.type("alph");
  await menu().getByText("Project Alpha").waitFor();
  assert((await menu().getByText("Meeting notes").count()) === 0, "current page should not be offered");
  await shot("10-link-menu");
});

await step("picking inserts a link that syncs as a pageLink", async () => {
  await page.keyboard.press("Enter");
  await editor().locator(".page-link", { hasText: "Project Alpha" }).waitFor();
  await page.keyboard.type("today.");
  const text = await editor().innerText();
  assert(!text.includes("[["), "trigger text left behind: " + text);
  await until(() => linksTo(byTitle("Meeting notes"), byTitle("Project Alpha").id), "link saved on server");
  assert(byTitle("Meeting notes").search_text.includes("today."), "text after link not saved");
});

await step("clicking the link opens the page; it shows 'Linked from'", async () => {
  await editor().locator(".page-link", { hasText: "Project Alpha" }).click();
  await until(async () => (await page.getByLabel("Page title").inputValue()) === "Project Alpha", "navigated");
  await page.getByText("Linked from").waitFor();
  await page.getByRole("link", { name: "Meeting notes" }).last().waitFor();
  await shot("11-backlinks");
});

await step("renaming the target updates the link text everywhere", async () => {
  await page.getByLabel("Page title").fill("Project Alpha v2");
  await page.getByRole("link", { name: "Meeting notes" }).last().click();
  await editor().locator(".page-link", { hasText: "Project Alpha v2" }).waitFor();
});

await step("'Create' option makes a new page and links it", async () => {
  await editor().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Next: [[");
  await menu().waitFor();
  await page.keyboard.type("Budget 2027");
  await menu().getByText("Create “Budget 2027”").click();
  await editor().locator(".page-link", { hasText: "Budget 2027" }).waitFor();
  await until(() => byTitle("Budget 2027") && linksTo(byTitle("Meeting notes"), byTitle("Budget 2027").id), "created + linked on server");
});

await step("slash menu 'Link to page' opens the page picker", async () => {
  await page.keyboard.press("Enter");
  await page.keyboard.type("/link");
  await menu().getByText("Link to page").waitFor();
  await page.keyboard.press("Enter");
  await menu().getByText("Project Alpha v2").waitFor({ timeout: 3000 });
  await page.keyboard.type("budget");
  await page.keyboard.press("Enter");
  await until(async () => (await editor().locator(".page-link", { hasText: "Budget 2027" }).count()) === 2, "second link inserted");
  const t = await editor().innerText();
  assert(!t.includes("/link") && !t.includes("[["), "leftover text: " + t);
});

await step("link survives reload (stored + re-rendered)", async () => {
  await until(() => links(byTitle("Meeting notes")) === 3, "3 links on server");
  // Reload once syncing is done: a request cut off by the reload would log an error.
  await sidebar().getByText("Saved", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await editor().locator(".page-link").count()) === 3, "3 links rendered after reload");
});

await step("trashed target shows struck-through; deleted shows 'Deleted page'", async () => {
  const id = byTitle("Budget 2027").id;
  await page.evaluate(() => 0);
  be.remoteWrite(id, { is_archived: true, archived_at: new Date().toISOString() });
  await until(async () => (await editor().locator(".page-link-missing", { hasText: "Budget 2027" }).count()) === 2, "struck through");
  be.remoteDelete(id);
  await until(async () => (await editor().getByText("Deleted page").count()) === 2, "deleted label");
  await shot("12-link-states");
});

await step("Today creates 'Daily notes' > YYYY-MM-DD, and reuses it", async () => {
  const d = new Date();
  const title = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await sidebar().getByText("Today").click();
  await until(async () => (await page.getByLabel("Page title").inputValue()) === title, "today's page open");
  await until(() => byTitle(title)?.parent_id && byTitle(title).parent_id === byTitle("Daily notes")?.id, "synced under Daily notes");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await sidebar().getByText("Today").click();
  await until(async () => (await page.getByLabel("Page title").inputValue()) === title, "reopened");
  await new Promise((r) => setTimeout(r, 1200));
  const count = [...be.db.values()].filter((p) => p.title === title).length;
  const parents = [...be.db.values()].filter((p) => p.title === "Daily notes").length;
  assert(count === 1 && parents === 1, `duplicates: ${count} day pages, ${parents} parents`);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Daily notes").waitFor();
});

async function shot(n) { await page.screenshot({ path: `${SHOTS}/${n}.png` }); }
await browser.close();
const w = Math.max(...results.map((r) => r[1].length));
for (const [s, n, ms, err] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n.padEnd(w)} ${String(ms).padStart(5)}ms${err ? "\n    → " + err : ""}`);
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
if (errors.length) console.log("\nBrowser errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
