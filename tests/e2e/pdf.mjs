import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";

const BASE = "http://localhost:4173";
const DIR = new URL("../output", import.meta.url).pathname;
const results = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await be.install(context);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
const sidebar = () => page.getByRole("navigation", { name: "Pages" });

// A page shaped like a real interview question bank, long enough for several pages.
const levels = { Basics: 8, Intermediate: 9, Hard: 8 };
const topics = ["Data Structures & Algorithms (Theory)", "Operating Systems", "Computer Networks", "Python"];
let md = "";
topics.forEach((t, i) => {
  md += `## ${i + 1}. ${t}\n\n`;
  for (const [level, n] of Object.entries(levels)) {
    md += `- ${level}\n`;
    for (let q = 1; q <= n; q++) md += `    ${q}. What is \`thing_${q}\` and when do you use it over the alternative? *(looking for: trade-offs, O(log n) lookups, a real example)*\n`;
  }
  md += `\n---\n\n`;
});
md += "## Checklist\n\n- [ ] Provide valid elapsed and remaining time (may be managed through server side)\n- [x] Should allow DOCX as input and convert to PDF\n\n";
md += "| Topic | Status |\n| --- | --- |\n| Routing | **in review** |\n| Upload | done |\n\n";
md += "```python\ndef memo(f):\n    cache = {}\n    return lambda n: cache.setdefault(n, f(n))\n```\n\n> Keep answers short; say the trade-off first.\n";
writeFileSync(`${DIR}/Interview prep.md`, md);

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.getByLabel("Email").fill(EMAIL); await page.getByLabel("Password").fill(PASSWORD);
await page.getByRole("button", { name: "Sign in" }).click();
await sidebar().waitFor();

await step("a long question-bank page exports to a clean A4 PDF even with Margins: None and Landscape", async () => {
  await sidebar().getByRole("button", { name: /Margin/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import Markdown" }).click()]);
  await chooser.setFiles([`${DIR}/Interview prep.md`]);
  await page.getByRole("status").filter({ hasText: "Imported" }).waitFor({ timeout: 10000 });
  const p = await until(() => [...be.db.values()].find((r) => r.title === "Interview prep"), "imported");
  await page.goto(`${BASE}/p/${p.id}`);
  const exportThen = async (pdfPath, opts) => {
    await page.evaluate(() => { window.__printed = null; window.print = () => { window.__printed = true; }; });
    const row = sidebar().getByRole("link", { name: "Interview prep", exact: true }).first().locator("..");
    await row.hover(); await row.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Export as PDF" }).click();
    await until(() => page.evaluate(() => window.__printed), "print dialog opened");
    writeFileSync(`${DIR}/printed-bank.html`, await page.evaluate(() => document.getElementById("print-root").innerHTML));
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, ...opts });
    // Saving fires afterprint, which removes the print view.
    await until(() => page.evaluate(() => !document.getElementById("print-root")), "print view removed after saving");
  };
  // Like your Chrome: no margins. Then landscape on Letter asked for: the page's A4 must win.
  await exportThen(`${DIR}/bank-none.pdf`, { margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await exportThen(`${DIR}/bank-landscape.pdf`, { landscape: true, format: "Letter", margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await exportThen(`${DIR}/bank-default-margins.pdf`, {});
  const { readFileSync } = await import("node:fs");
  const shape = (f) => {
    const data = readFileSync(f).toString("latin1");
    return { pages: (data.match(/\/Type\s*\/Page[^s]/g) ?? []).length, boxes: [...new Set([...data.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+)\]/g)].map((m) => m[1].trim()))] };
  };
  const shapes = ["none", "landscape", "default-margins"].map((v) => shape(`${DIR}/bank-${v}.pdf`));
  for (const sh of shapes) assert(sh.boxes.length === 1 && sh.boxes[0].startsWith("0 0 594.9") && sh.boxes[0].includes("841.9"), "not A4 portrait: " + sh.boxes);
  assert(new Set(shapes.map((sh) => sh.pages)).size === 1, "print settings changed the layout: " + shapes.map((sh) => sh.pages));
});

await browser.close();
for (const r of results) console.log(r.join(" "));
console.log(errors.length ? errors : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
