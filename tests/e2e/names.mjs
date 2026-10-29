import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }

await step("sign-up asks for a name (optional) and saves it with the account", async () => {
  const be = createBackend(); be.signupsOpen = true;
  const c = await b.newContext(); await be.install(c); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await p.getByText("Optional", { exact: true }).waitFor();
  await p.screenshot({ path: `${SHOTS}/100-signup-name.png` });
  await p.getByLabel(/^Name/).fill("  Asha Rao  ");
  await p.getByLabel("Email").fill("asha@example.com");
  await p.getByLabel("Password").fill("a-long-password");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByRole("heading", { name: "Check your email" }).waitFor();
  assert(be.lastSignup.body?.data?.full_name === "Asha Rao", "name sent: " + JSON.stringify(be.lastSignup.body?.data));
  // Leaving it empty sends no name at all.
  await p.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill("noname@example.com"); await p.getByLabel("Password").fill("a-long-password");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByRole("heading", { name: "Check your email" }).waitFor();
  assert(!be.lastSignup.body?.data?.full_name, "no name expected: " + JSON.stringify(be.lastSignup.body?.data));
  await c.close();
});

await step("account menu: add your name; it shows in the menu and the share panel", async () => {
  const be = createBackend();
  const c = await b.newContext({ viewport: { width: 1280, height: 800 } }); await be.install(c); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" });
  await nav.waitFor();
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByRole("menuitem", { name: "Settings" }).click();
  await p.getByLabel("Your name").fill("Vipul Chaudhary");
  await p.screenshot({ path: `${SHOTS}/101-name-settings.png` });
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await p.getByText("Saved.").waitFor();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: /, Vipul$/ }).waitFor(); // home greets by first name
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByText("Vipul Chaudhary", { exact: true }).waitFor();
  await p.keyboard.press("Escape");
  await nav.getByRole("button", { name: "New page" }).first().click();
  await p.getByLabel("Page title").fill("Plans");
  await p.getByRole("button", { name: "Share", exact: true }).click();
  await p.getByText("Vipul Chaudhary (you)", { exact: true }).waitFor();
  await p.keyboard.press("Escape");
  await c.close();
});

await step("Settings: Save stays off until the name changes", async () => {
  const be = createBackend();
  const c = await b.newContext(); await be.install(c); const p = await c.newPage();
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" }); await nav.waitFor();
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByRole("menuitem", { name: "Settings" }).click();
  const save = p.getByRole("button", { name: "Save", exact: true });
  assert(await save.isDisabled(), "save should start disabled");
  const input = p.getByLabel("Your name");
  const was = await input.inputValue();
  await input.fill(was + "x");
  assert(await save.isEnabled(), "a change turns it on");
  await input.fill(was);
  assert(await save.isDisabled(), "back to the saved name turns it off");
  await c.close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
