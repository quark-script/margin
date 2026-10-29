import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function ctx(opts = {}, init) {
  const be = createBackend(); be.signupsOpen = true;
  const c = await b.newContext({ viewport: { width: 1280, height: 860 }, ...opts }); await be.install(c);
  if (init) await c.addInitScript(init);
  const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 150)));
  return p;
}

await step("signed-out visitors see the landing page: private by default, Start writing, Sign in", async () => {
  const p = await ctx();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: /A quiet place/ }).waitFor();
  await p.getByText("Private by default. Your notes stay on your device and sync only if you want them to.").waitFor();
  await p.getByText("Free. No account needed.").waitFor();
  await p.screenshot({ path: `${SHOTS}/60-landing-desktop.png`, fullPage: true });
  await p.getByRole("button", { name: "Start writing" }).first().click();
  await p.getByRole("navigation", { name: "Pages" }).getByText("On this device").waitFor(); // no account, nothing syncs
  await p.context().close();
});

await step("Sign in from the landing page", async () => {
  const p = await ctx();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("link", { name: "Sign in" }).first().click();
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  assert(new URL(p.url()).pathname === "/login", p.url());
  await p.context().close();
});

await step("signing in from /login opens the app; '/' then shows the app, sign-out shows the sign-in form", async () => {
  const p = await ctx();
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" });
  await nav.waitFor();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await nav.waitFor();
  assert((await p.getByRole("heading", { name: /A quiet place/ }).count()) === 0, "landing shown to signed-in user");
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByText("Sign out").click();
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  await p.context().close();
});

await step("the installed app skips the landing page", async () => {
  const p = await ctx({}, () => Object.defineProperty(navigator, "standalone", { get: () => true }));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  await p.context().close();
});

await step("phone width: no sideways scroll; dark theme follows the system", async () => {
  for (const scheme of ["light", "dark"]) {
    const p = await ctx({ viewport: { width: 390, height: 844 }, colorScheme: scheme, isMobile: true, hasTouch: true });
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("heading", { name: /A quiet place/ }).waitFor();
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(over <= 0, `${scheme}: overflows by ${over}px`);
    await p.screenshot({ path: `${SHOTS}/61-landing-phone-${scheme}.png`, fullPage: true });
    if (scheme === "dark") assert(await p.evaluate(() => document.documentElement.classList.contains("dark")), "dark class");
    await p.context().close();
  }
  const d = await ctx({ colorScheme: "dark" });
  await d.goto(BASE, { waitUntil: "networkidle" });
  await d.screenshot({ path: `${SHOTS}/62-landing-desktop-dark.png` });
  await d.context().close();
});

await step("privacy policy: linked from the landing page, open to everyone", async () => {
  const p = await ctx();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("link", { name: "Privacy" }).click();
  await p.waitForURL(BASE + "/privacy");
  await p.getByRole("heading", { name: "Privacy", exact: true }).waitFor();
  await p.getByRole("link", { name: "margin@dhanpulse.in" }).first().waitFor();
  if ((await p.content()).includes("gmail.com")) throw new Error("personal address still on the privacy page");
  await p.screenshot({ path: `${SHOTS}/99-privacy.png`, fullPage: true });
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByRole("navigation", { name: "Pages" }).waitFor();
  await p.goto(BASE + "/privacy", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Privacy", exact: true }).waitFor();
  await p.context().close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
