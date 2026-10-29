import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, jwt, UID } from "./mock.mjs";

const BASE = process.env.BASE ?? "http://localhost:4173";
const SHOTS = process.env.SHOTS;
const results = [];
const errors = [];
let current = "";

async function step(name, fn) {
  current = name;
  const t = Date.now();
  try {
    await fn();
    results.push(["PASS", name, Date.now() - t]);
  } catch (e) {
    const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    await page.screenshot({ path: `${SHOTS}/FAIL-${slug}.png` }).catch(() => {});
    const dump = [...be.db.values()].map((p) => `${p.title || "(untitled)"}${p.is_archived ? "[A]" : ""}${p.is_favorite ? "[F]" : ""} txt=${JSON.stringify(p.search_text).slice(0, 40)}`).join(" | ");
    results.push(["FAIL", name, Date.now() - t, String(e?.message ?? e).split("\n")[0] + "\n    db: " + dump]);
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
async function until(fn, msg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timed out: ${msg}`);
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }).catch(() => chromium.launch());
const be = createBackend();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await be.install(context);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`[${current}] pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !/\[sync\] .*injected|Failed to load resource/.test(m.text())) errors.push(`[${current}] console: ${m.text().slice(0, 200)}`); });

const pages = () => [...be.db.values()];
const byTitle = (t) => pages().find((p) => p.title === t);
const editor = () => page.locator(".bn-editor[contenteditable=true]").first();
// The open page's own "⋯" menu in the top bar (sidebar rows have their own).
const topMenu = () => page.getByRole("navigation", { name: "Breadcrumb" }).locator("xpath=..").getByRole("button", { name: "More actions" });
const sidebar = () => page.getByRole("navigation", { name: "Pages" });

// ---------------- auth ----------------
await step("login page: no sign-up link, says Margin", async () => {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  assert((await page.getByText(/create one|create account/i).count()) === 0, "sign-up UI still present");
  await shot(page, "01-login");
});

await step("wrong password shows a clear error", async () => {
  await page.getByLabel("Email").fill(EMAIL);
  await page.locator('input[type=password]').fill("nope-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Email or password is wrong").waitFor();
});

await step("forgot password sends reset request", async () => {
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByRole("button", { name: "Send reset link" }).click();
  await page.getByText(/reset link is on its way/).waitFor();
  assert(be.recovers === 1, "recover endpoint not called");
  await page.getByRole("button", { name: "Back to sign in" }).click();
});

await step("sign in with a short (<8 char) existing password", async () => {
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD); // label must point at the input
  await page.getByRole("button", { name: "Sign in" }).click();
  await sidebar().waitFor();
  assert(be.signups === 0, "signup endpoint was hit");
});

await step("realtime subscription joined with 3 bindings", async () => {
  await until(() => [...be.sockets].some((s) => [...s.channels.values()].some((c) => c.bindings.length === 3)), "realtime join");
  const ch = [...[...be.sockets][0].channels.values()][0];
  const del = ch.bindings.find((b) => b.event === "DELETE");
  assert(del && !del.filter, "DELETE binding should be unfiltered");
});

// ---------------- pages ----------------
await step("create page, type title + body, syncs to server", async () => {
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Groceries");
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "Enter in title moves cursor into body");
  await page.keyboard.type("Buy oat milk and bananas");
  assert((await page.getByLabel("Page title").inputValue()) === "Groceries", "body text leaked into title");
  await until(() => byTitle("Groceries")?.search_text?.includes("oat milk"), "page with content on server");
  const p = byTitle("Groceries");
  assert(Array.isArray(p.content) && p.content.length > 0, "content not saved as blocks");
  assert(p.parent_id === null && p.owner_id === UID, "wrong owner/parent");
  await sidebar().getByText("Groceries").waitFor();
  await shot(page, "02-page");
});

await step("sub-page via 'Add a page inside' syncs with parent_id", async () => {
  await page.getByRole("button", { name: "Add a page inside" }).last().click();
  await page.getByLabel("Page title").fill("Weekend list");
  await until(() => byTitle("Weekend list")?.parent_id === byTitle("Groceries")?.id, "child with parent on server");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Groceries").waitFor();
});

await step("parent + child created in one flush (levelled upload)", async () => {
  // Use the UI quickly: new top page then immediately a child before the debounce fires.
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Projects");
  await page.getByRole("button", { name: "Add a page inside" }).last().click();
  await page.getByLabel("Page title").fill("Margin app");
  await until(() => byTitle("Margin app")?.parent_id && byTitle("Margin app").parent_id === byTitle("Projects")?.id, "both uploaded, child after parent");
});

await step("favorite toggles and shows in sidebar Favorites", async () => {
  await sidebar().getByText("Groceries").first().click();
  await page.getByRole("button", { name: "Add to favorites" }).click();
  await until(() => byTitle("Groceries")?.is_favorite === true, "is_favorite on server");
  await sidebar().getByText("Favorites").waitFor();
});

await step("search (Ctrl+K) finds a page by its body text", async () => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search pages and their contents").fill("bananas");
  const hit = page.getByRole("dialog").getByText("Groceries").first();
  await hit.waitFor();
  await page.keyboard.press("Escape");
});

await step("rename shows up in sidebar and on server", async () => {
  await page.getByLabel("Page title").fill("Groceries & home");
  await until(() => byTitle("Groceries & home"), "renamed on server");
  await sidebar().getByText("Groceries & home").first().waitFor();
});

await step("move page to trash (and its child goes with it)", async () => {
  await topMenu().click();
  await page.getByRole("menuitem", { name: "Move to trash" }).or(page.getByText("Move to trash")).first().click();
  await until(() => byTitle("Groceries & home")?.is_archived === true && byTitle("Groceries & home")?.archived_at, "archived on server");
  assert((await sidebar().getByText("Groceries & home").count()) === 0, "still visible in sidebar");
});

await step("trash panel lists it; restore brings it back", async () => {
  await sidebar().getByText("Trash").click();
  const panel = page.getByRole("dialog", { name: "Trash" }).or(page.locator('[aria-label="Trash"]'));
  await panel.getByText("Groceries & home").waitFor();
  await panel.getByRole("button", { name: "Restore" }).first().click();
  await until(() => byTitle("Groceries & home")?.is_archived === false && byTitle("Groceries & home")?.archived_at === null, "restored on server");
  await page.keyboard.press("Escape");
  await sidebar().getByText("Groceries & home").first().waitFor();
});

await step("delete forever removes page and its sub-pages on server", async () => {
  await sidebar().getByText("Groceries & home").first().click();
  await topMenu().click();
  await page.getByText("Move to trash").first().click();
  await until(() => byTitle("Groceries & home")?.is_archived, "archived");
  await sidebar().getByText("Trash").click();
  const panel = page.locator('[aria-label="Trash"]');
  await panel.getByRole("button", { name: "Delete forever" }).first().click();
  await until(() => !byTitle("Groceries & home") && !byTitle("Weekend list"), "deleted + cascaded on server");
  await page.keyboard.press("Escape");
});

// ---------------- other devices ----------------
await step("edit from another device appears live (realtime UPDATE)", async () => {
  await sidebar().getByText("Projects").first().click();
  const id = byTitle("Projects").id;
  be.remoteWrite(id, { title: "Projects (from phone)" });
  await sidebar().getByText("Projects (from phone)").waitFor({ timeout: 4000 });
  await until(async () => (await page.getByLabel("Page title").inputValue()) === "Projects (from phone)", "title field updated");
});

await step("body edited on another device reloads the open editor", async () => {
  const id = byTitle("Projects (from phone)").id;
  be.remoteWrite(id, { content: [{ id: "b1", type: "paragraph", props: {}, content: [{ type: "text", text: "Written on my phone", styles: {} }], children: [] }], search_text: "Written on my phone" });
  await editor().getByText("Written on my phone").waitFor({ timeout: 4000 });
});

await step("page deleted on another device disappears live (realtime DELETE)", async () => {
  const id = byTitle("Projects (from phone)").id;
  be.remoteDelete(id);
  await until(async () => (await sidebar().getByText("Projects (from phone)").count()) === 0, "gone from sidebar");
  assert(!byTitle("Margin app"), "child should be gone on server too");
  await until(async () => (await sidebar().getByText("Margin app").count()) === 0, "child gone from sidebar");
});

// ---------------- offline ----------------
await step("offline: edits are kept and sync after reconnect", async () => {
  await sidebar().getByRole("button", { name: "New page" }).first().click();
  await page.getByLabel("Page title").fill("Offline note");
  await until(() => byTitle("Offline note"), "page created online");
  await context.setOffline(true);
  await page.getByLabel("Page title").press("End");
  await page.getByLabel("Page title").press("Enter");
  await until(() => page.evaluate(() => !!document.activeElement?.closest(".bn-editor")), "cursor in body");
  await page.keyboard.type("typed while offline");
  await page.getByText(/Offline/).first().waitFor();
  await new Promise((r) => setTimeout(r, 1500));
  assert(!byTitle("Offline note").search_text.includes("typed while offline"), "should not have reached server while offline");
  await shot(page, "03-offline");
  await context.setOffline(false);
  await until(() => byTitle("Offline note")?.search_text.includes("typed while offline"), "synced after reconnect", 8000);
});

await step("reload keeps everything (IndexedDB) and reopens last page", async () => {
  await page.reload({ waitUntil: "networkidle" });
  await until(async () => (await page.getByLabel("Page title").inputValue()) === "Offline note", "last page reopened");
  await editor().getByText("typed while offline").waitFor();
});

await step("offline reload: app shell loads from service worker with local data", async () => {
  await until(() => page.evaluate(() => navigator.serviceWorker?.controller != null), "service worker controlling page", 8000);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sidebar().getByText("Offline note").first().waitFor({ timeout: 8000 });
  await page.getByLabel("Page title").fill("Offline note (edited offline after reload)");
  await new Promise((r) => setTimeout(r, 1200));
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await until(() => byTitle("Offline note (edited offline after reload)"), "synced after offline reload", 8000);
});

await step("server write failure shows 'Sync failed', then recovers", async () => {
  be.failWrites("XX000");
  await page.getByLabel("Page title").fill("Retry me");
  await page.getByText("Sync failed").first().waitFor({ timeout: 5000 });
  await page.getByText("Sync failed").first().click(); // retry
  await until(() => byTitle("Retry me"), "synced after retry");
});

// ---------------- mobile + dark ----------------
await step("mobile layout: drawer opens and navigates", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar" }).first().click();
  await sidebar().getByText("Retry me").first().waitFor();
  await shot(page, "04-mobile-drawer");
  await sidebar().getByText("Retry me").first().click();
  await page.getByLabel("Page title").waitFor();
  await shot(page, "05-mobile-page");
});

await step("dark theme applies", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.evaluate(() => document.documentElement.classList.contains("dark")), "no .dark class");
  await shot(page, "06-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => localStorage.setItem("theme", "light"));
});

// ---------------- sign out + recovery ----------------
await step("sign out returns to login and clears local data", async () => {
  await page.reload({ waitUntil: "networkidle" });
  await sidebar().getByText("Margin").first().click();
  await page.getByText("Sign out").click();
  await page.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
  const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("keyval-store"); r.onsuccess = () => { const tx = r.result.transaction("keyval", "readonly"); const q = tx.objectStore("keyval").getAllKeys(); q.onsuccess = () => res(q.result.filter((k) => String(k).startsWith("notes:"))); }; r.onerror = () => res([]); }));
  assert(left.length === 0, "local data left: " + left.join(","));
});

await step("password reset link -> set new password -> app", async () => {
  const t = jwt();
  await page.goto(`${BASE}/#access_token=${t}&expires_at=${Math.floor(Date.now() / 1000) + 3600}&expires_in=3600&refresh_token=rt1&token_type=bearer&type=recovery`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Set a new password" }).waitFor();
  await page.getByLabel("New password").fill("a-new-password-123");
  await page.getByRole("button", { name: "Save password" }).click();
  await sidebar().waitFor();
  assert(be.passwordUpdated === "a-new-password-123", "password not sent");
  await sidebar().getByText("Retry me").first().waitFor({ timeout: 5000 }); // pulled from server after fresh login
});

await browser.close();

const w = Math.max(...results.map((r) => r[1].length));
for (const [s, n, ms, err] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n.padEnd(w)} ${String(ms).padStart(5)}ms${err ? "\n    → " + err : ""}`);
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
if (errors.length) console.log("\nBrowser errors:\n" + [...new Set(errors)].slice(0, 20).join("\n"));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
