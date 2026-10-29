import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID } from "./mock.mjs";

const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const results = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const CLAUDE = { id: "c1a0de00-0000-4000-8000-000000000001", name: "Claude", uri: "https://claude.ai", logo_uri: "" };
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const ask = (id, client = CLAUDE) => be.oauthRequests.set(id, { client, redirect_uri: CALLBACK });

let page;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 9000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
async function step(name, fn) {
  try { await fn(); results.push(["✓", name]); }
  catch (e) { await page?.screenshot({ path: `${SHOTS}/FAIL-agents-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png` }).catch(() => {}); results.push(["✗", name, String(e?.message ?? e).split("\n")[0]]); }
}
// device: "new" (nothing saved, so the app's own default applies) or "syncOff" (Sync all pages
// switched off on it). Otherwise the mock's usual device, which syncs everything.
async function context(opts = {}, device) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["clipboard-read", "clipboard-write"], ...opts });
  be.freshDevices = Boolean(device);
  await be.install(c);
  be.freshDevices = false;
  if (device === "syncOff") await c.addInitScript((k) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, "shared"); } catch {} }, `margin:sync:${UID}`);
  // The AI app's callback: a stand-in page that shows where it was sent.
  await c.route("https://claude.ai/**", (r) => r.fulfill({ contentType: "text/html", body: `<h1>Back in Claude</h1><p id="q">${new URL(r.request().url()).search}</p>` }));
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|claude\.ai/.test(m.text()) && errors.push(m.text().slice(0, 160)));
  return { c, p };
}
async function signIn(p) {
  await p.getByLabel("Email").fill(EMAIL); await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in", exact: true }).last().click();
}
// This device's Sync all pages choice: "all" (on) or "shared" (off).
const syncSetting = async (c) => ((await c.storageState()).origins.find((o) => o.origin === BASE)?.localStorage ?? []).find((i) => i.name === `margin:sync:${UID}`)?.value;
// Signed in on a device where Sync all pages is switched off.
async function syncOffDevice() {
  const ctx = await context({}, "syncOff");
  await ctx.p.goto(BASE + "/login", { waitUntil: "networkidle" });
  await signIn(ctx.p);
  await ctx.p.getByRole("navigation", { name: "Pages" }).waitFor();
  return ctx;
}
const CHATGPT = { id: "c4a7c4a7-0000-4000-8000-000000000003", name: "ChatGPT", uri: "https://chatgpt.com", logo_uri: "" };

await step("the guide: address to copy, steps per app, Claude Code command and Cursor link use this site", async () => {
  const { c, p } = await context();
  page = p;
  await p.goto(BASE + "/agents", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Use Margin with AI agents" }).waitFor();
  const box = p.getByRole("region", { name: "Server address" });
  await box.getByText(`${BASE}/mcp`, { exact: true }).waitFor();
  await box.getByRole("button", { name: "Copy" }).click();
  await box.getByRole("button", { name: "Copied" }).waitFor();
  assert((await p.evaluate(() => navigator.clipboard.readText())) === `${BASE}/mcp`, "clipboard");
  await p.getByRole("tabpanel", { name: "Claude" }).getByText("Add custom connector").waitFor();
  await p.getByRole("tab", { name: "Claude Code" }).click();
  await p.getByRole("tabpanel", { name: "Claude Code" }).getByText(`claude mcp add --transport http margin ${BASE}/mcp`).waitFor();
  await p.getByRole("tab", { name: "Cursor" }).click();
  const href = await p.getByRole("link", { name: "Add to Cursor" }).getAttribute("href");
  const config = JSON.parse(Buffer.from(new URL(href).searchParams.get("config"), "base64").toString());
  assert(config.url === `${BASE}/mcp`, "cursor config: " + JSON.stringify(config));
  await p.getByRole("tab", { name: "VS Code" }).click();
  const vs = decodeURIComponent((await p.getByRole("link", { name: "Install in VS Code" }).getAttribute("href")).replace("vscode:mcp/install?", ""));
  assert(JSON.parse(vs).url === `${BASE}/mcp` && JSON.parse(vs).type === "http", vs);
  await p.screenshot({ path: `${SHOTS}/190-agents-guide.png`, fullPage: true });
  await c.close();
});

await step("the guide on a phone fits the screen", async () => {
  const { c, p } = await context({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  page = p;
  await p.goto(BASE + "/agents", { waitUntil: "networkidle" });
  await p.getByRole("tab", { name: "Claude Code" }).tap();
  assert(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), "sideways scroll");
  await p.screenshot({ path: `${SHOTS}/191-agents-guide-phone.png`, fullPage: true });
  await c.close();
});

await step("opening /mcp in a browser shows the guide", async () => {
  const { c, p } = await context();
  page = p;
  await p.goto(BASE + "/mcp", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Use Margin with AI agents" }).waitFor();
  assert(new URL(p.url()).pathname === "/agents", p.url());
  await c.close();
});

const owner = await context({}, "new");
await step("signed out: the app's request waits through sign-in, then Allow sends you back with a code", async () => {
  const { p } = owner;
  page = p;
  ask("req-1");
  await p.goto(BASE + "/oauth/consent?authorization_id=req-1", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Connect an AI app to Margin" }).waitFor();
  await p.getByRole("button", { name: "Sign in" }).click();
  await signIn(p);
  await p.getByRole("heading", { name: "Connect Claude to Margin" }).waitFor();
  await p.getByText(`Claude wants to use your Margin account, ${EMAIL}.`).waitFor();
  await p.getByText("Search and read your pages").waitFor();
  await p.getByText("Afterwards you go back to claude.ai.", { exact: false }).waitFor();
  // A new device syncs all pages, so there's nothing to offer.
  assert((await p.getByRole("checkbox", { name: /Also sync all pages on this device/ }).count()) === 0, "offered to sync on a device that syncs");
  await p.screenshot({ path: `${SHOTS}/192-agents-consent.png` });
  await p.getByRole("button", { name: "Allow" }).click();
  await p.getByRole("heading", { name: "Back in Claude" }).waitFor();
  assert((await p.locator("#q").innerText()).includes("code=code-req-1"), await p.locator("#q").innerText());
  assert(be.oauthDecisions.at(-1).action === "approve" && be.oauthDecisions.at(-1).uid === UID, JSON.stringify(be.oauthDecisions));
});

await step("allowed before: the next request goes straight back to the app", async () => {
  const { p } = owner;
  page = p;
  ask("req-2");
  await p.goto(BASE + "/oauth/consent?authorization_id=req-2");
  await p.getByRole("heading", { name: "Back in Claude" }).waitFor();
  assert((await p.locator("#q").innerText()).includes("code=again-req-2"), await p.locator("#q").innerText());
});

await step("Cancel tells the app no; an expired request says to start again", async () => {
  const { p } = owner;
  page = p;
  const other = { id: "0b0b0b0b-0000-4000-8000-000000000002", name: "Cursor", uri: "", logo_uri: "" };
  be.oauthRequests.set("req-3", { client: other, redirect_uri: "http://localhost:4567/callback" });
  await p.route("http://localhost:4567/**", (r) => r.fulfill({ contentType: "text/html", body: `<h1>Back in Cursor</h1><p id="q">${new URL(r.request().url()).search}</p>` }));
  await p.goto(BASE + "/oauth/consent?authorization_id=req-3", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "Connect Cursor to Margin" }).waitFor();
  await p.getByText("Afterwards you go back to the app on this computer.", { exact: false }).waitFor();
  await p.getByRole("button", { name: "Cancel" }).click();
  await p.getByRole("heading", { name: "Back in Cursor" }).waitFor();
  assert((await p.locator("#q").innerText()).includes("error=access_denied"), await p.locator("#q").innerText());
  await p.goto(BASE + "/oauth/consent?authorization_id=req-gone", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "That didn't work" }).waitFor();
  await p.getByText("This request has expired or was already used.", { exact: false }).waitFor();
  await p.goto(BASE + "/oauth/consent", { waitUntil: "networkidle" });
  await p.getByRole("heading", { name: "This link isn't complete" }).waitFor();
});

await step("Settings › AI agents: address, guide link, connected apps with last use, Disconnect", async () => {
  const { p } = owner;
  page = p;
  be.agentActivity.set(UID, [{ client_id: CLAUDE.id, last_used_at: new Date(Date.now() - 2 * 3600e3).toISOString() }]);
  await p.goto(BASE + "/settings", { waitUntil: "networkidle" });
  const section = p.getByRole("region", { name: "AI agents" });
  await section.getByText(`${BASE}/mcp`).waitFor();
  const row = section.getByText("Claude", { exact: true }).locator("../..");
  await row.getByText(/^Connected .*, last used 2h ago$/).waitFor();
  await p.screenshot({ path: `${SHOTS}/193-agents-settings.png` });
  p.once("dialog", (d) => { assert(d.message().startsWith("Disconnect Claude?"), d.message()); void d.accept(); });
  await row.getByRole("button", { name: "Disconnect" }).click();
  await section.getByText("None yet.").waitFor();
  assert((be.oauthGrants.get(UID) ?? []).length === 0, "grant kept");
  await section.getByRole("button", { name: "How to connect" }).click();
  await p.getByRole("heading", { name: "Use Margin with AI agents" }).waitFor();
});

await step("version history marks what an agent changed", async () => {
  const { p } = owner;
  page = p;
  const id = "dddddddd-9999-4000-8000-000000000001";
  const now = new Date().toISOString();
  be.db.set(id, { id, owner_id: UID, parent_id: null, title: "Agent page", icon: null, content: [{ type: "paragraph", content: [{ type: "text", text: "hello", styles: {} }] }], search_text: "hello", position: 9, is_favorite: false, is_archived: false, archived_at: null, created_at: now, updated_at: now });
  be.versions.push({ id: 9001, page_id: id, owner_id: UID, title: "Agent page", icon: null, content: be.db.get(id).content, sig: "x", edited_by: UID, via: "Claude", saved_at: now, savedMs: Date.now(), sealed: true });
  await p.goto(BASE + `/p/${id}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "More actions" }).last().click();
  await p.getByRole("menuitem", { name: "Version history" }).click();
  await p.getByText("You, via Claude").waitFor();
});

await step("Sync all pages off here: connecting uploads this device's pages first, then goes back", async () => {
  const { c, p } = await syncOffDevice();
  page = p;
  const from = p.url();
  await p.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "New page" }).first().click();
  await until(async () => p.url() !== from && /\/p\//.test(p.url()) && (await p.getByLabel("Page title").inputValue()) === "", "the new page is open");
  const id = new URL(p.url()).pathname.split("/").pop();
  await p.getByLabel("Page title").fill("Device only plan");
  await p.waitForTimeout(1500);
  assert(!be.db.has(id), "uploaded with Sync all pages off");
  ask("req-5");
  await p.goto(BASE + "/oauth/consent?authorization_id=req-5", { waitUntil: "networkidle" });
  assert(await p.getByRole("checkbox", { name: /Also sync all pages on this device/ }).isChecked(), "not ticked to start with");
  await p.getByRole("button", { name: "Allow" }).click();
  await p.getByRole("heading", { name: "Back in Claude" }).waitFor();
  assert(be.db.get(id)?.title === "Device only plan", "not uploaded before going back: " + JSON.stringify(be.db.get(id)?.title ?? null));
  assert((await syncSetting(c)) === "all", "Sync all pages still off");
  await c.close();
});

await step("left unticked, sync stays off; Settings says what that means and turns it on", async () => {
  const { c, p } = await syncOffDevice();
  page = p;
  be.oauthRequests.set("req-6", { client: CHATGPT, redirect_uri: CALLBACK });
  await p.goto(BASE + "/oauth/consent?authorization_id=req-6", { waitUntil: "networkidle" });
  await p.getByRole("checkbox", { name: /Also sync all pages on this device/ }).uncheck();
  await p.screenshot({ path: `${SHOTS}/194-agents-consent-sync-unticked.png` });
  await p.getByRole("button", { name: "Allow" }).click();
  await p.getByRole("heading", { name: "Back in Claude" }).waitFor();
  assert((await syncSetting(c)) === "shared", "Sync all pages turned on anyway");
  await p.goto(BASE + "/settings", { waitUntil: "networkidle" });
  const section = p.getByRole("region", { name: "AI agents" });
  await section.getByText("Sync all pages is off on this device").waitFor();
  await section.screenshot({ path: `${SHOTS}/195-agents-settings-sync-off.png` });
  await section.getByRole("button", { name: "Sync all pages" }).click();
  await section.getByText("Sync all pages is off on this device").waitFor({ state: "detached" });
  assert((await p.getByRole("switch", { name: "Sync all pages" }).getAttribute("aria-checked")) === "true", "switch still off");
  await c.close();
});

await step("Sync all pages off here: your page that isn't on this device says why, and syncing opens it", async () => {
  const id = "dddddddd-9999-4000-8000-000000000002";
  const now = new Date().toISOString();
  be.db.set(id, { id, owner_id: UID, parent_id: null, title: "Written by Claude", icon: null, content: [{ type: "paragraph", content: [{ type: "text", text: "from the agent", styles: {} }] }], search_text: "from the agent", position: 11, is_favorite: false, is_archived: false, archived_at: null, created_at: now, updated_at: now });
  const { c, p } = await syncOffDevice();
  page = p;
  // Not ours at all: the usual answer.
  await p.goto(BASE + "/p/eeeeeeee-0000-4000-8000-000000000404", { waitUntil: "networkidle" });
  await p.getByText("This page doesn't exist, or you don't have access to it.").waitFor();
  await p.goto(BASE + `/p/${id}`, { waitUntil: "networkidle" });
  await p.getByText("This page is in your account, but not on this device").waitFor();
  await p.screenshot({ path: `${SHOTS}/196-page-not-synced-here.png` });
  await p.getByRole("button", { name: "Sync all pages" }).click();
  await until(async () => (await p.getByLabel("Page title").inputValue()) === "Written by Claude", "the page opens");
  await c.close();
});

await step("without an account: connecting asks for a free account first", async () => {
  const { c, p } = await context();
  page = p;
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Start writing" }).first().click();
  await p.getByRole("navigation", { name: "Pages" }).waitFor();
  ask("req-4");
  await p.goto(BASE + "/oauth/consent?authorization_id=req-4", { waitUntil: "networkidle" });
  await p.getByText("Connecting an app needs a free Margin account, so it can reach your pages.").waitFor();
  await p.getByRole("button", { name: "Create an account" }).waitFor();
  await c.close();
});

await owner.c.close();
await browser.close();
for (const r of results) console.log(r.join(" "));
console.log(errors.length ? errors : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
