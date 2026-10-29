import { chromium } from "playwright";
import { createBackend, UID, GOOGLE_EMAIL } from "./mock.mjs";
const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [], errs = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
async function fresh(be, opts = {}) {
  const c = await b.newContext({ viewport: { width: 1180, height: 820 }, ...opts }); await be.install(c);
  const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message)); return p;
}
const now = () => new Date().toISOString();

await step("button shows only when Google is switched on in Supabase", async () => {
  const be = createBackend(); be.googleEnabled = false;
  const p = await fresh(be);
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  assert((await p.getByRole("button", { name: "Continue with Google" }).count()) === 0, "shown while off");
  await p.context().close();
  const be2 = createBackend();
  const p2 = await fresh(be2);
  await p2.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await p2.getByRole("button", { name: "Continue with Google" }).waitFor();
  await p2.screenshot({ path: `${SHOTS}/97-signup-google.png` });
  await p2.getByRole("button", { name: "Sign in", exact: true }).last().click().catch(() => {});
  await p2.context().close();
});

await step("Continue with Google: picks an account, comes back signed in with name and photo", async () => {
  const be = createBackend();
  const p = await fresh(be);
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue with Google" }).click();
  const nav = p.getByRole("navigation", { name: "Pages" });
  await nav.waitFor({ timeout: 10000 });
  assert(be.lastAuthorize?.provider === "google" && be.lastAuthorize?.prompt === "select_account", "authorize: " + JSON.stringify(be.lastAuthorize));
  assert(be.lastAuthorize.redirect === `${BASE}/`, "should come back to this site: " + be.lastAuthorize.redirect);
  assert(!p.url().includes("access_token"), "tokens left in the address: " + p.url());
  const photo = nav.locator("img").first();
  await photo.waitFor();
  assert((await photo.getAttribute("src")) === "https://lh3.example.com/gina.png", "avatar");
  await nav.getByRole("button", { name: /Margin/ }).first().click();
  await p.getByText("Gina Google", { exact: true }).waitFor();
  await p.getByText(GOOGLE_EMAIL, { exact: true }).waitFor();
  await p.getByRole("menuitem", { name: "Settings" }).click();
  await p.getByRole("button", { name: "Set a password" }).waitFor(); // no password yet
  await p.getByText("Connected. You can sign in with Google.").waitFor();
  await p.context().close();
});

await step("invited page link, signed out: Continue with Google lands on the page", async () => {
  const be = createBackend();
  const H = "eeeeeeee-0000-4000-8000-000000000001";
  be.db.set(H, { id: H, owner_id: UID, parent_id: null, title: "Trip plan", icon: "🧭", content: [{ type: "paragraph", content: [{ type: "text", text: "Day one" }] }], search_text: "", position: 0, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now() });
  be.members.push({ page_id: H, owner_id: UID, email: GOOGLE_EMAIL, can_edit: true, created_at: now() });
  const p = await fresh(be);
  await p.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await p.getByText("Sign in or create an account to open this page.").waitFor();
  await p.getByRole("button", { name: "Continue with Google" }).click();
  await p.waitForURL(`${BASE}/p/${H}`, { timeout: 10000 });
  await p.getByRole("heading", { name: "Trip plan" }).waitFor();
  await p.getByRole("navigation", { name: "Pages" }).getByText("Shared with me").waitFor();
  await p.context().close();
});

await step("cancelled at Google: back on sign-in with a short message, address cleaned", async () => {
  const be = createBackend(); be.googleCancel = true;
  const p = await fresh(be);
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue with Google" }).click();
  await p.getByText("That didn't work. Please try again.").waitFor({ timeout: 10000 });
  assert(!p.url().includes("error"), "error left in the address: " + p.url());
  await p.context().close();
});

await step("dark mode and phone width look right", async () => {
  const be = createBackend();
  const p = await fresh(be, { viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true });
  await p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue with Google" }).waitFor();
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(over <= 0, "sideways scroll " + over);
  await p.screenshot({ path: `${SHOTS}/98-login-google-dark-phone.png` });
  await p.context().close();
});

await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
