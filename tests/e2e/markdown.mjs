import { chromium } from "playwright";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { writeFileSync, readFileSync } from "node:fs";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";

const BASE = "http://localhost:4173";
const DIR = new URL("../output", import.meta.url).pathname;
const SHOTS = `${DIR}/shots`;
const results = [], errors = [];
let current = "";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
await be.install(context);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`[${current}] pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`[${current}] console: ${m.text().slice(0, 200)}`));
async function step(name, fn) {
  current = name; const t = Date.now();
  try { await fn(); results.push(["PASS", name, Date.now() - t]); }
  catch (e) { await page.screenshot({ path: `${SHOTS}/FAIL-md-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["FAIL", name, Date.now() - t, String(e?.message ?? e).split("\n")[0]]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const all = () => [...be.db.values()];
const byTitle = (t, parent) => all().find((p) => p.title === t && (parent === undefined || p.parent_id === parent));
const json = (p) => JSON.stringify(p?.content ?? []);
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function openMenu() {
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings", level: 1 }).waitFor();
}
async function importFiles(paths) {
  await openMenu();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Markdown" }).click()]);
  await chooser.setFiles(paths);
  await page.getByRole("status").filter({ hasText: "Imported" }).waitFor({ timeout: 10000 });
  return page.getByRole("status").innerText();
}

const vault = zipSync({
  "Vault/Home.md": strToU8("---\ntags: [a]\n---\n# Welcome\n\nSee [[Projects/Alpha|the alpha]] and [[Missing note]].\n\n![[pic.png|200]]\n\n- [ ] buy milk\n- [x] done thing\n\n| A | B |\n| --- | --- |\n| 1 | **two** |\n"),
  "Vault/Projects.md": strToU8("About projects"),
  "Vault/Projects/Alpha.md": strToU8("Alpha body, back to [[Home]]."),
  "Vault/Projects/Beta.md": strToU8("Beta has ![shot](../attachments/pic2.png) inline"),
  "Vault/attachments/pic.png": PNG,
  "Vault/attachments/pic2.png": PNG,
  "Vault/.obsidian/app.json": strToU8("{}"),
});
writeFileSync(`${DIR}/vault.zip`, vault);
writeFileSync(`${DIR}/Loose note.md`, "Just one note with **bold**.");

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(EMAIL);
await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

let root;
await step("import a vault zip: folders become nested pages under one root", async () => {
  const msg = await importFiles([`${DIR}/vault.zip`]);
  assert(/Imported 5 pages/.test(msg), "notice: " + msg);
  root = await until(() => byTitle("Vault", null), "root synced");
  const home = await until(() => byTitle("Home", root.id), "Home under root");
  const projects = await until(() => byTitle("Projects", root.id), "Projects under root");
  await until(() => byTitle("Alpha", projects.id) && byTitle("Beta", projects.id), "Alpha/Beta under Projects");
  assert(!all().some((p) => p.title === "app" || p.title === ".obsidian"), "hidden files imported");
  assert(json(projects).includes("About projects"), "Projects.md not used as folder page");
  assert(!json(home).includes("tags"), "front matter kept");
  await page.waitForURL(new RegExp(root.id));
});

await step("[[links]] become page links; unknown ones stay as text", async () => {
  const home = byTitle("Home"), alpha = byTitle("Alpha");
  await until(() => json(byTitle("Home")).includes(`"pageId":"${alpha.id}"`), "Home links Alpha");
  await until(() => json(byTitle("Alpha")).includes(`"pageId":"${home.id}"`), "Alpha links Home");
  assert(byTitle("Home").search_text.includes("Missing note"), "missing link text lost: " + byTitle("Home").search_text);
  assert(!json(byTitle("Home")).includes("margin.invalid"), "placeholder URL left behind");
});

await step("images are uploaded, to-dos and tables survive", async () => {
  const c = json(byTitle("Home"));
  assert(/"type":"image"[^}]*"url":"notes-media:/.test(c), "image not uploaded: " + c.slice(0, 400));
  assert(json(byTitle("Beta")).includes("notes-media:"), "relative image not resolved: " + json(byTitle("Beta")));
  assert(be.objects.size === 2, "uploads: " + be.objects.size);
  assert(c.includes('"checkListItem"') && c.includes('"checked":true'), "to-dos lost");
  assert(c.includes('"table"') && c.includes('"two"'), "table lost");
});

await step("imported page opens in the editor with link chips", async () => {
  await page.goto(`${BASE}/p/${byTitle("Home").id}`);
  await page.locator(".page-link", { hasText: "Alpha" }).waitFor();
  await page.screenshot({ path: `${SHOTS}/md-10-imported-home.png` });
});

let exported;
await step("export all: zip mirrors the tree with [[links]] and attachments", async () => {
  // trash one page: it must not be exported
  await page.goto(`${BASE}/p/${byTitle("Beta").id}`);
  const row = sidebar().getByRole("link", { name: "Beta" }).locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await until(() => byTitle("Beta").is_archived, "Beta trashed on server");
  await openMenu();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export all pages" }).click()]);
  assert(/^margin-export-\d{4}-\d{2}-\d{2}\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const path = `${DIR}/export.zip`; await dl.saveAs(path);
  exported = unzipSync(readFileSync(path));
  const names = Object.keys(exported).sort();
  for (const f of ["Vault.md", "Vault/Home.md", "Vault/Projects.md", "Vault/Projects/Alpha.md"]) assert(names.includes(f), "missing " + f + " in " + names.join(","));
  assert(!names.some((n) => n.includes("Beta")), "trashed page exported");
  const home = strFromU8(exported["Vault/Home.md"]);
  assert(home.includes("[[Alpha]]"), "link not exported: " + home);
  const img = home.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1];
  assert(img?.startsWith("../attachments/"), "image path: " + img + "\n" + home);
  assert(exported[img.replace("../", "")], "attachment file missing");
  assert(home.includes("[ ] buy milk") && home.includes("[x] done thing"), "todos: " + home);
  assert(strFromU8(exported["Vault/Projects/Alpha.md"]).includes("[[Home]]"), "Alpha link");
  await page.getByRole("status").filter({ hasText: "Exported" }).waitFor();
});

await step("re-importing the export restores links between the copies", async () => {
  const before = all().length;
  await importFiles([`${DIR}/export.zip`]);
  await until(() => all().length >= before + 4, "copies synced");
  // The export has one top item (Vault.md + Vault/), so no wrapper page: a second "Vault" appears.
  const vaultCopy = all().find((p) => p.parent_id === null && p.title === "Vault" && p.id !== root.id);
  assert(vaultCopy, "copy missing: " + all().filter((p) => !p.parent_id).map((p) => p.title));
  const homeCopy = byTitle("Home", vaultCopy.id), alphaCopy = byTitle("Alpha", byTitle("Projects", vaultCopy.id).id);
  assert(json(homeCopy).includes(`"pageId":"${alphaCopy.id}"`), "copy links to copy");
  assert(json(byTitle("Projects", vaultCopy.id)).includes("About projects"), "folder page content");
});

await step("a single loose .md file becomes one top-level page", async () => {
  await importFiles([`${DIR}/Loose note.md`]);
  const p = await until(() => byTitle("Loose note", null), "loose page");
  assert(json(p).includes('"bold":true'), "formatting lost");
});

async function rowMenu(title, item) {
  const row = sidebar().getByRole("link", { name: title, exact: true }).first().locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

await step("copy as Markdown: page links point at Margin, to-dos kept", async () => {
  await page.goto(`${BASE}/p/${byTitle("Home", root.id).id}`);
  await rowMenu("Home", "Copy as Markdown");
  await page.getByRole("status").filter({ hasText: "Copied as Markdown" }).waitFor();
  const md = await page.evaluate(() => navigator.clipboard.readText());
  const alpha = all().find((p) => p.title === "Alpha" && json(byTitle("Home", root.id)).includes(p.id));
  assert(md.includes(`[Alpha](https://margin.example.com/p/${alpha.id})`), "link: " + md);
  assert(md.includes("[ ] buy milk") && md.includes("**two**"), "body: " + JSON.stringify(md));
  assert(!md.includes("notes-media:"), "private image path leaked");
});

await step("the page menu offers Copy as Markdown and Export as PDF, not Export as Markdown", async () => {
  await page.goto(`${BASE}/p/${byTitle("Home", root.id).id}`);
  const row = sidebar().getByRole("link", { name: "Home", exact: true }).first().locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  const items = await page.getByRole("menuitem").allTextContents();
  assert(items.includes("Copy as Markdown") && items.includes("Export as PDF"), "items: " + items);
  assert(!items.some((t) => t.includes("Export as Markdown")), "old item still there: " + items);
  await page.keyboard.press("Escape");
});

await step("export as PDF: prints the page (title, links, to-dos, table, image) named after it, then tidies up", async () => {
  const home = byTitle("Home", root.id);
  await page.goto(`${BASE}/p/${home.id}`);
  const before = await until(async () => ((await page.title()) === "Home" ? "Home" : null), "page title set");
  // Stand in for the print dialog: record what it would print and leave it open.
  await page.evaluate(() => {
    window.__printed = null;
    window.print = () => {
      const r = document.getElementById("print-root");
      window.__printed = { title: document.title, html: r?.innerHTML ?? "", shownOnScreen: r ? getComputedStyle(r).display !== "none" : null };
    };
  });
  await rowMenu("Home", "Export as PDF");
  const printed = await until(() => page.evaluate(() => window.__printed), "print dialog opened");
  writeFileSync(`${DIR}/printed-home.html`, printed.html);
  const alpha = all().find((p) => p.title === "Alpha" && json(home).includes(p.id));
  assert(printed.title === "Home", "file name comes from: " + printed.title);
  assert(printed.shownOnScreen === false, "print view must stay hidden on screen");
  assert(printed.html.includes('class="print-title">Home</h1>'), "title: " + printed.html.slice(0, 200));
  assert(printed.html.includes(`href="https://margin.example.com/p/${alpha.id}"`), "page link");
  assert(/type="checkbox"/.test(printed.html) && printed.html.includes("buy milk"), "to-dos");
  assert(printed.html.includes("<table") && printed.html.includes("two"), "table");
  assert(printed.html.includes("<img") && !printed.html.includes("notes-media:"), "image with a working link");
  // What it looks like printed, and a real PDF from the same view.
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: `${SHOTS}/md-30-pdf-print.png`, fullPage: true });
  const pdf = await page.pdf({ path: `${DIR}/printed-home.pdf`, format: "A4" });
  await page.emulateMedia({ media: null });
  assert(pdf.length > 5000, "pdf size " + pdf.length);
  // Closing the dialog removes the print view and gives the tab its title back.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  assert(await page.evaluate(() => !document.getElementById("print-root")), "print view left behind");
  assert((await page.title()) === before, `title not restored: ${await page.title()} vs ${before}`);
});

await step("export as PDF works in dark mode and from a page that isn't open", async () => {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.goto(`${BASE}/p/${byTitle("Loose note", null).id}`);
  await until(async () => (await page.title()) === "Loose note", "page title set");
  await page.evaluate(() => { window.__printed = null; window.print = () => { window.__printed = { title: document.title, html: document.getElementById("print-root").innerHTML }; }; });
  await rowMenu("Alpha", "Export as PDF");
  const printed = await until(() => page.evaluate(() => window.__printed), "print dialog opened");
  assert(printed.html.includes(">Alpha</h1>") && printed.html.includes("back to"), "the right page: " + printed.html.slice(0, 160));
  assert(printed.title === "Alpha", "file named after the exported page: " + printed.title);
  await page.emulateMedia({ media: "print" });
  const color = await page.evaluate(() => getComputedStyle(document.getElementById("print-root")).color);
  await page.emulateMedia({ media: null });
  assert(color === "rgb(30, 31, 34)", "printed text must be dark on white even in dark mode: " + color);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  assert((await page.title()) === "Loose note", "tab title back to the open page: " + (await page.title()));
});

await step("printing the app normally (Ctrl+P) still prints the page, not a blank sheet", async () => {
  await page.goto(`${BASE}/p/${byTitle("Home", root.id).id}`);
  await page.emulateMedia({ media: "print" });
  const shown = await page.evaluate(() => getComputedStyle(document.getElementById("root")).display);
  await page.emulateMedia({ media: null });
  assert(shown !== "none", "app hidden when printing without an export");
});

await step("shared pages show a marker in the sidebar", async () => {
  const home = byTitle("Home", root.id);
  assert((await sidebar().getByLabel("Shared").count()) === 0, "marker before sharing");
  be.shares.set(home.id, { page_id: home.id, token: "tokabc", can_edit: false });
  await page.reload(); await sidebar().waitFor();
  await page.goto(`${BASE}/p/${home.id}`);
  const row = sidebar().getByRole("link", { name: /Home/ }).first();
  await row.getByLabel("Shared").waitFor();
  assert((await sidebar().getByLabel("Shared").count()) === 1, "only the shared page is marked");
  await page.screenshot({ path: `${SHOTS}/md-20-shared-marker.png` });
});

await browser.close();
for (const r of results) console.log(r.join(" | "));
console.log("errors:", errors.length ? errors : "none");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
