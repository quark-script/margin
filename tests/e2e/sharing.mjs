import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID, GUEST_EMAIL, GUEST_PASSWORD } from "./mock.mjs";

const BASE = "http://localhost:4173";
const SITE = "https://margin.example.com";
const SHOTS = new URL("../output", import.meta.url).pathname;
const results = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
be.versionGapMs = 1500;

const now = () => new Date().toISOString();
const para = (...inline) => ({ type: "paragraph", content: inline });
const txt = (text) => ({ type: "text", text });
const seed = (id, parent, title, content, extra = {}) =>
  be.db.set(id, { id, owner_id: UID, parent_id: parent, title, icon: null, content, search_text: "", position: 0, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now(), ...extra });
const H = "cccccccc-0000-4000-8000-000000000001", T = "cccccccc-0000-4000-8000-000000000002", S = "cccccccc-0000-4000-8000-000000000003", P = "cccccccc-0000-4000-8000-000000000004";
seed(H, null, "Health", [
  para(txt("Health notes.")),
  para(txt("See "), { type: "pageLink", props: { pageId: T } }, txt(" and "), { type: "pageLink", props: { pageId: P } }),
  { type: "image", props: { url: `notes-media:${UID}/pic.png`, caption: "" } },
], { icon: "💪" });
seed(T, H, "Training", [para(txt("Push pull legs"))]);
seed(S, H, "Skin", [para(txt("Sunscreen daily"))], { position: 1 });
seed(P, null, "Secret diary", [para(txt("private stuff"))], { position: 1 });

const ctxOpts = { viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] };
const ownerCtx = await browser.newContext(ctxOpts);
const guestCtx = await browser.newContext({ ...ctxOpts, viewport: { width: 1180, height: 800 } });
await be.install(ownerCtx); await be.install(guestCtx);
const owner = await ownerCtx.newPage(), guest = await guestCtx.newPage();
const watch = (who, pg) => {
  pg.on("pageerror", (e) => errors.push(`[${who}] ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`[${who}] ${m.text().slice(0, 160)}`));
};
watch("owner", owner); watch("guest", guest);
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 9000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(["✓", name, Date.now() - t]); }
  catch (e) {
    const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
    await owner.screenshot({ path: `${SHOTS}/FAIL-sharing-owner-${slug}.png` }).catch(() => {});
    await guest.screenshot({ path: `${SHOTS}/FAIL-sharing-guest-${slug}.png` }).catch(() => {});
    results.push(["✗", name, Date.now() - t, String(e?.message ?? e).split("\n")[0]]);
  }
}
const sidebar = (pg) => pg.getByRole("navigation", { name: "Pages" });
const editorOf = (pg) => pg.locator("main .bn-editor, article .bn-editor").first();
async function signIn(pg, email, password) {
  await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
  await pg.getByLabel("Email").fill(email); await pg.getByLabel("Password").fill(password);
  await pg.getByRole("button", { name: "Sign in" }).click();
  await sidebar(pg).waitFor();
}
const panel = () => owner.getByRole("menu").filter({ has: owner.getByLabel("Email to invite") });
async function openPanel() {
  if (await owner.getByLabel("Email to invite").isVisible().catch(() => false)) return;
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await owner.getByLabel("Email to invite").waitFor();
}
async function closePanel() {
  for (let i = 0; i < 3 && (await owner.getByLabel("Email to invite").isVisible().catch(() => false)); i++) await owner.keyboard.press("Escape");
}
async function invite(email) {
  await openPanel();
  await owner.getByLabel("Email to invite").fill(email);
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
}
async function setMemberAccess(email, label) {
  await openPanel();
  await owner.getByLabel(`Access for ${email}`).click();
  await owner.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}
async function setGeneral(label) {
  await openPanel();
  await owner.getByLabel("General access").click();
  await owner.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
}
async function freshPage() {
  const c = await browser.newContext({ viewport: { width: 1100, height: 800 } }); await be.install(c);
  const pg = await c.newPage(); watch("fresh", pg); return pg;
}

await signIn(owner, EMAIL, PASSWORD);
await owner.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
await owner.getByLabel("Page title").waitFor();

await step("panel: one link, you as owner, general access starts private", async () => {
  await openPanel();
  await panel().getByText("You", { exact: true }).waitFor();
  await panel().getByText("Owner", { exact: true }).waitFor();
  assert((await owner.getByLabel("General access").innerText()).includes("Only people invited"), "general access should start private");
  await panel().getByRole("button", { name: "Copy link" }).click();
  await panel().getByText("Link copied").waitFor();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  assert(link === `${SITE}/p/${H}`, "link: " + link);
  await owner.screenshot({ path: `${SHOTS}/90-share-panel.png` });
});

await step("invite: checks the address, defaults to Can edit, emails the person", async () => {
  await invite("nope");
  await panel().getByText("Enter a valid email address.").waitFor();
  await invite(EMAIL);
  await panel().getByText("They already have access.").waitFor();
  await invite("Rahul@Example.com");
  await panel().getByRole("list", { name: "People with access" }).getByText(GUEST_EMAIL).waitFor();
  assert(be.members.length === 1 && be.members[0].email === GUEST_EMAIL && be.members[0].can_edit === true, "member: " + JSON.stringify(be.members));
  await until(() => be.invitesSent.length === 1, "invitation email requested");
  assert(be.invitesSent[0].email === GUEST_EMAIL && be.invitesSent[0].page_id === H, "email for: " + JSON.stringify(be.invitesSent));
  await owner.getByRole("status").filter({ hasText: `Invitation sent to ${GUEST_EMAIL}.` }).waitFor();
  assert((await owner.getByLabel("Email to invite").inputValue()) === "", "input should clear");
  await invite(GUEST_EMAIL);
  await panel().getByText("They already have access.").waitFor();
  await owner.getByLabel("Email to invite").fill("");
  await owner.screenshot({ path: `${SHOTS}/91-share-panel-invited.png` });
});

await step("when the email can't be sent, the owner is told to send the link", async () => {
  be.inviteResult = { sent: false, reason: "not_configured" };
  await invite("second@example.com");
  await owner.getByRole("status").filter({ hasText: "send them the link" }).waitFor();
  be.inviteResult = { sent: true };
  await owner.getByLabel("Access for second@example.com").click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await until(() => be.members.length === 1, "second removed");
});

await step("change access and resend from a menu inside the panel; the panel stays open", async () => {
  await setMemberAccess(GUEST_EMAIL, "Can view");
  await until(() => be.members[0].can_edit === false, "role saved");
  assert(await owner.getByLabel("Email to invite").isVisible(), "panel should stay open");
  await owner.getByLabel(`Access for ${GUEST_EMAIL}`).click();
  await owner.getByRole("menuitem", { name: "Resend invitation" }).click();
  await until(() => be.invitesSent.filter((x) => x.email === GUEST_EMAIL).length === 2, "resent");
  await closePanel();
  await sidebar(owner).getByLabel("Shared").first().waitFor();
});

await step("invitee: 'Shared with me' opens the same /p/ link, read-only, sub-pages included", async () => {
  await signIn(guest, GUEST_EMAIL, GUEST_PASSWORD);
  await sidebar(guest).getByRole("link", { name: /Health/ }).click();
  await guest.waitForURL(`${BASE}/p/${H}`);
  await guest.getByRole("heading", { name: "Health" }).waitFor();
  await guest.getByText("View only", { exact: true }).waitFor();
  assert((await editorOf(guest).getAttribute("contenteditable")) === "false", "viewer can't edit");
  await guest.locator("article section").getByRole("link", { name: "Training" }).click();
  await guest.waitForURL(`${BASE}/p/${T}`);
  await guest.getByRole("heading", { name: "Training" }).waitFor();
  await guest.getByRole("navigation", { name: "Breadcrumb" }).getByText("Health").waitFor();
  await guest.screenshot({ path: `${SHOTS}/92-invitee.png` });
  await guest.goto(`${BASE}/p/${P}`, { waitUntil: "networkidle" });
  await guest.getByText("This page doesn't exist, or you don't have access to it.").waitFor();
  await guest.getByText(`If someone shared it with you, ask them to invite ${GUEST_EMAIL}.`).waitFor();
  assert((await guest.getByText("private stuff").count()) === 0, "private content leaked");
});

await step("a viewer can't save by calling the server", async () => {
  const status = await guest.evaluate(async ({ id }) => {
    const k = Object.keys(localStorage).find((x) => x.endsWith("-auth-token"));
    const jwt = JSON.parse(localStorage.getItem(k)).access_token;
    const r = await fetch("https://test.supabase.co/rest/v1/rpc/shared_page_save", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ p_page_id: id, p_editor: "ed-viewer-xxxxxxxxxxxx", p_content: [], p_search_text: "" }) });
    return r.status;
  }, { id: H });
  assert(status >= 400, "viewer save should fail, got " + status);
});

await step("owner gives edit access: the invitee edits, the owner sees it live and waits", async () => {
  await guest.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await guest.getByText("View only", { exact: true }).waitFor();
  await setMemberAccess(GUEST_EMAIL, "Can edit");
  await until(() => be.members[0].can_edit === true, "role saved");
  await closePanel();
  await until(async () => (await editorOf(guest).getAttribute("contenteditable")) === "true", "guest can edit now", 10000);
  await editorOf(guest).locator(".bn-inline-content").first().click();
  await guest.keyboard.press("End");
  await guest.keyboard.type(" invited edit");
  await until(() => JSON.stringify(be.db.get(H).content).includes("invited edit"), "saved on server");
  await editorOf(owner).getByText("invited edit").waitFor({ timeout: 8000 });
  await owner.getByText("rahul is editing this page").waitFor({ timeout: 8000 });
  assert((await editorOf(owner).getAttribute("contenteditable")) === "false", "owner should wait");
  const last = be.versions.filter((v) => v.page_id === H).at(-1);
  assert(last?.edited_by && last.edited_by !== UID, "version should be under rahul");
});

await step("invitee restores an earlier version from their history", async () => {
  await guest.waitForTimeout(1800);
  await guest.keyboard.type(" and more");
  await until(() => JSON.stringify(be.db.get(H).content).includes("and more"), "second edit saved");
  await guest.getByRole("button", { name: "More actions" }).last().click();
  await guest.getByRole("menuitem", { name: "Version history" }).click();
  const dialog = guest.getByRole("dialog", { name: "Version history" });
  const items = dialog.getByRole("complementary", { name: "Versions" }).getByRole("button");
  await until(async () => (await items.count()) >= 2, "versions listed");
  await items.last().click();
  await dialog.getByRole("region", { name: "Preview" }).getByText("invited edit").waitFor();
  await dialog.getByRole("button", { name: "Restore this version" }).click();
  await guest.getByRole("status").filter({ hasText: "Version restored" }).waitFor();
  await until(() => !JSON.stringify(be.db.get(H).content).includes("and more"), "restored on server");
  await until(async () => !(await editorOf(guest).innerText()).includes("and more"), "guest editor reloaded");
  await guest.locator("article h1").click();
});

let anon;
await step("anyone with the link (view): signed out, the same link shows the page, images included", async () => {
  await setGeneral("Anyone with the link");
  await until(() => be.shares.has(H), "share row");
  await owner.getByText("Anyone on the internet with the link").waitFor();
  await owner.screenshot({ path: `${SHOTS}/93-share-panel-public.png` });
  await closePanel();
  anon = await freshPage();
  await anon.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await anon.getByRole("heading", { name: "Health" }).waitFor();
  assert((await editorOf(anon).getAttribute("contenteditable")) === "false", "read-only");
  assert((await anon.getByRole("link", { name: "Sign in to edit" }).count()) === 0, "no edit prompt on a view link");
  const src = await until(() => anon.locator("[data-content-type=image] img").first().getAttribute("src", { timeout: 500 }), "image src", 8000);
  assert(src.includes(`/functions/v1/share-file?page=${H}`), "img src: " + src);
  await anon.locator(".page-link", { hasText: "Private page" }).waitFor();
  await anon.screenshot({ path: `${SHOTS}/94-public.png` });
  await anon.goto(`${BASE}/p/${P}`, { waitUntil: "networkidle" });
  await anon.getByText("Sign in or create an account to open this page.").waitFor();
});

await step("link can edit: 'Sign in to edit', sign in, back on the page and editing (no invite needed)", async () => {
  // The invitee leaves the page, freeing it. In the app: a reload's unlock (sent while the page
  // unloads) doesn't reliably get through this test browser's request interception.
  await sidebar(guest).getByText("Today", { exact: true }).click();
  await until(() => [...be.locks.values()].every((l) => l.expires < Date.now()) || be.locks.size === 0, "page free", 5000);
  await openPanel();
  await owner.getByLabel(`Access for ${GUEST_EMAIL}`).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await until(() => be.members.length === 0, "invite removed");
  await owner.getByLabel("Link access").click();
  await owner.getByRole("menuitemradio", { name: /^Can edit/ }).click();
  await until(() => be.shares.get(H)?.can_edit === true, "link can edit");
  await closePanel();
  await anon.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await anon.getByRole("link", { name: "Sign in to edit" }).click();
  await anon.getByText("Sign in or create an account to edit the shared page.").waitFor();
  await anon.getByLabel("Email").fill(GUEST_EMAIL); await anon.getByLabel("Password").fill(GUEST_PASSWORD);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await anon.waitForURL(`${BASE}/p/${H}`, { timeout: 10000 });
  await sidebar(anon).waitFor(); // inside the app now
  await until(async () => (await editorOf(anon).getAttribute("contenteditable")) === "true", "editable via link");
  await editorOf(anon).locator(".bn-inline-content").first().click();
  await anon.keyboard.press("End");
  await anon.keyboard.type(" via link");
  await until(() => JSON.stringify(be.db.get(H).content).includes("via link"), "link edit saved");
  await anon.locator("article h1").click();
  await anon.context().close();
});

await step("sub-page panel shows access that comes from the page above", async () => {
  be.members.push({ page_id: H, owner_id: UID, email: GUEST_EMAIL, can_edit: true, created_at: now() });
  await owner.goto(`${BASE}/p/${T}`, { waitUntil: "networkidle" });
  await owner.getByLabel("Page title").waitFor();
  await openPanel();
  const people = panel().getByRole("list", { name: "People with access" });
  await people.getByText(GUEST_EMAIL).waitFor();
  await people.getByText("Via").first().waitFor();
  await panel().getByText("Anyone with the link", { exact: true }).waitFor();
  await owner.screenshot({ path: `${SHOTS}/95-subpage-panel.png` });
  await closePanel();
  await owner.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await owner.getByLabel("Page title").waitFor();
});

await step("old links keep working: /s/<token> and /shared/...", async () => {
  const token = be.shares.get(H).token;
  const pg = await freshPage();
  await pg.goto(`${BASE}/s/${token}`, { waitUntil: "networkidle" });
  await pg.waitForURL(`${BASE}/p/${H}`);
  await pg.getByRole("heading", { name: "Health" }).waitFor();
  await pg.context().close();
  await guest.goto(`${BASE}/shared/${H}/${T}`, { waitUntil: "networkidle" });
  await guest.waitForURL(`${BASE}/p/${T}`);
  await guest.getByRole("heading", { name: "Training" }).waitFor();
});

await step("only people invited again: an open public page closes to sign-in", async () => {
  const pg = await freshPage();
  await pg.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await pg.getByRole("heading", { name: "Health" }).waitFor();
  await setGeneral("Only people invited");
  await until(() => !be.shares.has(H), "share row removed");
  await closePanel();
  await pg.getByText("Sign in or create an account to open this page.").waitFor({ timeout: 9000 });
  await pg.context().close();
});

await step("owner removes the invitee: their open page says so, and it leaves their sidebar", async () => {
  await guest.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await guest.getByRole("heading", { name: "Health" }).waitFor();
  await openPanel();
  await owner.getByLabel(`Access for ${GUEST_EMAIL}`).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await until(() => be.members.length === 0, "removed");
  await closePanel();
  await guest.getByText("This page doesn't exist, or you don't have access to it.").waitFor({ timeout: 9000 });
  await guest.reload({ waitUntil: "networkidle" });
  await sidebar(guest).waitFor();
  assert((await sidebar(guest).getByText("Shared with me").count()) === 0, "section should be gone");
});

await step("invitation for someone without an account: sign-up with the address filled in", async () => {
  const pg = await freshPage();
  await pg.goto(`${BASE}/signup?email=${encodeURIComponent("newbie@example.com")}&next=${encodeURIComponent(`/p/${H}`)}`, { waitUntil: "networkidle" });
  await pg.getByRole("heading", { name: "Create your account" }).waitFor();
  assert((await pg.getByLabel("Email").inputValue()) === "newbie@example.com", "email prefilled");
  await pg.getByText("Sign in or create an account to open this page.").waitFor();
  // The confirmation link signs them in and brings them to the page (the mock signs in as the owner).
  await pg.goto(`${BASE}/auth/confirm?token_hash=good&type=email`, { waitUntil: "networkidle" });
  await pg.waitForURL(`${BASE}/p/${H}`, { timeout: 10000 });
  await pg.context().close();
});

await step("invitee can leave a page", async () => {
  be.members.push({ page_id: H, owner_id: UID, email: GUEST_EMAIL, can_edit: false, created_at: now() });
  await guest.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await guest.getByRole("heading", { name: "Health" }).waitFor();
  guest.once("dialog", (d) => d.accept());
  await guest.getByRole("button", { name: "More actions" }).last().click();
  await guest.getByRole("menuitem", { name: "Leave page" }).click();
  await guest.waitForURL(`${BASE}/`);
  await until(() => be.members.length === 0, "left");
});

await step("phones: the panel fits the screen, and shared pages keep the sidebar button", async () => {
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await owner.getByLabel("Page title").waitFor();
  await openPanel();
  const box = await panel().boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390, "panel overflows: " + JSON.stringify(box));
  await owner.screenshot({ path: `${SHOTS}/96-share-panel-phone.png` });
  await closePanel();
  be.members.push({ page_id: H, owner_id: UID, email: GUEST_EMAIL, can_edit: true, created_at: now() });
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.goto(`${BASE}/p/${H}`, { waitUntil: "networkidle" });
  await guest.getByRole("heading", { name: "Health" }).waitFor();
  await guest.getByRole("button", { name: "Open sidebar" }).first().click();
  await sidebar(guest).getByText("Shared with me").waitFor();
  const over = await guest.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(over <= 0, "sideways scroll " + over);
});

await browser.close();
const w = Math.max(...results.map((r) => r[1].length));
for (const [s, n, ms, err] of results) console.log(`${s} ${n.padEnd(w)} ${String(ms).padStart(6)}ms${err ? "\n    → " + err : ""}`);
console.log(`\n${results.filter((r) => r[0] === "✓").length}/${results.length} passed`);
console.log(errors.length ? "Browser errors:\n" + [...new Set(errors)].join("\n") : "no browser errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
