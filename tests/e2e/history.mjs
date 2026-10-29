import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { await page.screenshot({ path: `${SHOTS}/FAIL-hist-${n.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const be = createBackend(); be.versionGapMs = 1500; // a short idle gap starts a new version
const ctx = await b.newContext({ viewport: { width: 1280, height: 820 } }); await be.install(ctx);
const page = await ctx.newPage();
page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
const sidebar = () => page.getByRole("navigation", { name: "Pages" });
const byTitle = (t) => [...be.db.values()].find((p) => p.title === t);
const dialog = () => page.getByRole("dialog", { name: "Version history" });
const editor = () => page.locator("main .bn-editor").first();

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(EMAIL); await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

async function openHistory(title) {
  const row = sidebar().getByRole("link", { name: title, exact: true }).first().locator("..");
  await row.hover();
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  await dialog().waitFor();
}

await step("edits separated by an idle gap become separate versions", async () => {
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Plan");
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "cursor in body");
  await page.keyboard.type("first draft");
  await until(() => byTitle("Plan")?.search_text.includes("first draft"), "first draft synced");
  await page.waitForTimeout(2000);
  await page.keyboard.type(" then second thoughts");
  await until(() => byTitle("Plan")?.search_text.includes("second thoughts"), "second synced");
  const vs = be.versions.filter((v) => v.page_id === byTitle("Plan").id);
  assert(vs.length >= 2, "versions: " + vs.length);
});

await step("history lists versions newest first; the newest is 'Current' and can't be restored", async () => {
  await openHistory("Plan");
  const items = dialog().getByRole("complementary", { name: "Versions" }).getByRole("button");
  await until(async () => (await items.count()) >= 2, "list loaded");
  await dialog().getByText("Current").waitFor();
  await dialog().getByText("Today").waitFor();
  await dialog().getByText("You").first().waitFor();
  await dialog().getByRole("region", { name: "Preview" }).getByText("second thoughts").waitFor();
  assert((await dialog().getByRole("button", { name: "Restore this version" }).count()) === 0, "restore offered on current");
});

await step("the newest version highlights what changed since the one before", async () => {
  const bar = dialog().getByRole("region", { name: "Preview" }).locator("p[aria-live]");
  await until(async () => /Since .*1 edited/.test(await bar.innerText()), "summary says 1 edited");
  const ins = dialog().locator(".version-diff ins");
  await until(async () => (await ins.allInnerTexts()).join("").includes("then second thoughts"), "added words highlighted");
  assert((await dialog().locator(".version-diff del").count()) === 0, "nothing was removed");
  assert((await dialog().locator(".diff-changed").count()) === 1, "one line marked as edited");
  await page.screenshot({ path: `${SHOTS}/72-history-diff.png` });
});

await step("Highlight changes off shows the plain page, and the choice is remembered", async () => {
  const sw = dialog().getByRole("switch", { name: "Highlight changes" });
  assert((await sw.getAttribute("aria-checked")) === "true", "on by default");
  await sw.click();
  await until(async () => (await dialog().locator(".version-diff").count()) === 0, "diff hidden");
  await dialog().getByRole("region", { name: "Preview" }).locator(".bn-editor").getByText("second thoughts").waitFor();
  assert((await page.evaluate(() => localStorage.getItem("margin:history-highlight"))) === "off", "choice saved");
  await sw.click();
  await dialog().locator(".version-diff").waitFor();
});

await step("preview an older version, then restore it", async () => {
  const items = dialog().getByRole("complementary", { name: "Versions" }).getByRole("button");
  await items.last().click();
  const preview = dialog().getByRole("region", { name: "Preview" });
  await preview.getByText("first draft").waitFor();
  assert((await preview.getByText("second thoughts").count()) === 0, "older preview shows newer text");
  await preview.getByText("The oldest version in the history.").waitFor();
  assert((await dialog().getByRole("switch").count()) === 0, "nothing to compare the oldest with");
  await page.screenshot({ path: `${SHOTS}/70-history.png` });
  await dialog().getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("status").filter({ hasText: "Version restored" }).waitFor();
  assert((await dialog().count()) === 0, "dialog should close");
  await editor().getByText("first draft").waitFor();
  assert(!(await editor().innerText()).includes("second thoughts"), "editor not reloaded");
  await until(() => !JSON.stringify(byTitle("Plan").content).includes("second thoughts"), "restore synced");
});

await step("the state before the restore is kept: history now has it plus the restore on top", async () => {
  const vs = be.versions.filter((v) => v.page_id === byTitle("Plan").id);
  assert(vs.some((v) => JSON.stringify(v.content).includes("second thoughts")), "pre-restore state lost");
  assert(!JSON.stringify(vs.at(-1).content).includes("second thoughts"), "newest version should be the restore");
  await openHistory("Plan");
  const items = dialog().getByRole("complementary", { name: "Versions" }).getByRole("button");
  await until(async () => (await items.count()) >= 3, "3 versions listed");
  const del = dialog().locator(".version-diff del");
  await until(async () => (await del.allInnerTexts()).join("").includes("then second thoughts"), "removed words struck through");
  await page.keyboard.press("Escape");
  assert((await dialog().count()) === 0, "Escape closes");
});

await step("keep typing after a restore: editing works and saves", async () => {
  await editor().locator(".bn-inline-content").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" again");
  await until(() => byTitle("Plan").search_text.includes("first draft again"), "post-restore edit synced");
});

const planVersions = () => be.versions.filter((v) => v.page_id === byTitle("Plan").id).length;

await step("a save that only adds an empty line doesn't make a version", async () => {
  await page.waitForTimeout(2000); // the last editing session is over
  const before = planVersions();
  const blocks = byTitle("Plan").content.length;
  const line = editor().locator(".bn-inline-content").first();
  const box = await line.boundingBox();
  await line.click({ position: { x: box.width - 2, y: box.height / 2 } });
  await page.waitForTimeout(150);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await until(() => byTitle("Plan").content.length > blocks || JSON.stringify(byTitle("Plan").content).match(/"content":\[\]/g)?.length > 1, "empty line synced");
  await page.waitForTimeout(300);
  assert(byTitle("Plan").search_text.includes("first draft again"), "the line was split: " + byTitle("Plan").search_text);
  assert(planVersions() === before, `versions went from ${before} to ${planVersions()}: ` + JSON.stringify(be.versions.filter((v) => v.page_id === byTitle("Plan").id).slice(-2).map((v) => [v.id, v.sealed, v.sig])));
});

await step("an editing session that ends where it started leaves no version", async () => {
  await page.waitForTimeout(2000);
  const before = planVersions();
  await page.keyboard.type("xyz");
  await until(() => byTitle("Plan").search_text.includes("xyz"), "xyz synced");
  assert(planVersions() === before + 1, "typing should start a version");
  be.versionGapMs = 8000; // keep this session open while it's undone
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  await until(() => !byTitle("Plan").search_text.includes("xyz"), "undo synced");
  await until(() => planVersions() === before, `versions should go back to ${before}, are ${planVersions()}`);
  be.versionGapMs = 1500;
});

await step("checking a to-do shows as Checked", async () => {
  await page.keyboard.type("[] buy milk");
  await until(() => JSON.stringify(byTitle("Plan").content).includes("checkListItem"), "to-do synced");
  await page.waitForTimeout(2000);
  await editor().locator('[data-content-type="checkListItem"] input[type="checkbox"]').click();
  await until(() => JSON.stringify(byTitle("Plan").content).includes('"checked":true'), "checked synced");
  await openHistory("Plan");
  const changed = dialog().locator(".diff-changed");
  await until(async () => (await changed.count()) === 1, "one edited line");
  assert((await changed.locator(".diff-note").innerText()) === "Checked", "note: " + (await changed.locator(".diff-note").innerText()));
  assert((await changed.getByRole("img", { name: "Done" }).count()) === 1, "box shows done");
  await page.screenshot({ path: `${SHOTS}/73-history-checked.png` });
  await page.keyboard.press("Escape");
});

await step("phone: list first, tap shows the preview, back returns", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar" }).first().click();
  await openHistory("Plan");
  const list = dialog().getByRole("complementary", { name: "Versions" });
  await list.getByRole("button").last().click();
  await dialog().getByRole("region", { name: "Preview" }).getByText("first draft").waitFor();
  assert(!(await list.isVisible()), "list should hide on phones while previewing");
  await page.screenshot({ path: `${SHOTS}/71-history-phone.png` });
  await dialog().getByRole("button", { name: "Back to versions" }).click();
  await list.waitFor({ state: "visible" });
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
