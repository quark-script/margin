import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID, GUEST_EMAIL, GUEST_PASSWORD, GUEST_UID, GOOGLE_EMAIL } from "./mock.mjs";

const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const results = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const now = () => new Date().toISOString();
const seed = (id, parent, title, extra = {}) =>
  be.db.set(id, { id, owner_id: UID, parent_id: parent, title, icon: null, content: [{ type: "paragraph", content: [{ type: "text", text: `${title} text` }] }], search_text: "", position: 0, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now(), ...extra });
const TEAM = "dddddddd-0000-4000-8000-000000000001", SUB = "dddddddd-0000-4000-8000-000000000002";
seed(TEAM, null, "Team plan");
seed(SUB, TEAM, "Launch notes");

const ctxOpts = { viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] };
const ownerCtx = await browser.newContext(ctxOpts), guestCtx = await browser.newContext(ctxOpts);
await be.install(ownerCtx); await be.install(guestCtx);
const owner = await ownerCtx.newPage(), guest = await guestCtx.newPage();
for (const [who, pg] of [["owner", owner], ["guest", guest]]) {
  pg.on("pageerror", (e) => errors.push(`[${who}] ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`[${who}] ${m.text().slice(0, 160)}`));
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 9000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out: " + msg); }
async function step(name, fn) {
  try { await fn(); results.push(["✓", name]); }
  catch (e) {
    const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
    await owner.screenshot({ path: `${SHOTS}/FAIL-roles-owner-${slug}.png` }).catch(() => {});
    await guest.screenshot({ path: `${SHOTS}/FAIL-roles-guest-${slug}.png` }).catch(() => {});
    results.push(["✗", name, String(e?.message ?? e).split("\n")[0]]);
  }
}
const sidebar = (pg) => pg.getByRole("navigation", { name: "Pages" });
async function signIn(pg, email, password) {
  await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
  await pg.getByLabel("Email").fill(email); await pg.getByLabel("Password").fill(password);
  await pg.getByRole("button", { name: "Sign in" }).click();
  await sidebar(pg).waitFor();
}
const people = (pg) => pg.getByRole("list", { name: "People with access" });
async function openShare(pg) {
  if (await people(pg).isVisible().catch(() => false)) return;
  await pg.getByRole("button", { name: "Share", exact: true }).click();
  await people(pg).waitFor();
}
async function closeShare(pg) { for (let i = 0; i < 3 && (await people(pg).isVisible().catch(() => false)); i++) await pg.keyboard.press("Escape"); }
async function invite(pg, email, role) {
  await openShare(pg);
  await pg.getByLabel("Access for new person").click();
  await pg.getByRole("menuitemradio", { name: new RegExp(`^${role}`) }).click();
  await pg.getByLabel("Email to invite").fill(email);
  await pg.getByRole("button", { name: "Invite", exact: true }).click();
}
async function setAccess(pg, email, role) {
  await openShare(pg);
  await pg.getByLabel(`Access for ${email}`).click();
  await pg.getByRole("menuitemradio", { name: new RegExp(`^${role}`) }).click();
}
const member = (email) => be.members.find((m) => m.page_id === TEAM && m.email === email);

await signIn(owner, EMAIL, PASSWORD);
await owner.goto(`${BASE}/p/${TEAM}`, { waitUntil: "networkidle" });

await step("the owner can give Full access, Can edit or Can view", async () => {
  await openShare(owner);
  await owner.getByLabel("Access for new person").click();
  const options = await owner.getByRole("menuitemradio").allInnerTexts();
  assert(options.map((o) => o.split("\n")[0]).join(",") === "Full access,Can edit,Can view", "options: " + options.join(" | "));
  await owner.keyboard.press("Escape");
  await invite(owner, GUEST_EMAIL, "Can view");
  await until(() => member(GUEST_EMAIL), "rahul invited");
  await invite(owner, GOOGLE_EMAIL, "Can edit");
  await invite(owner, "new@example.com", "Can edit");
  await until(() => member("new@example.com"), "new invited");
  assert(!member(GUEST_EMAIL).can_edit && !member(GUEST_EMAIL).can_share, "rahul should view only");
  assert(member(GOOGLE_EMAIL).can_edit && !member(GOOGLE_EMAIL).can_share, "gina should edit");
  await closeShare(owner);
});

await step("someone who can view sees the Share panel read only: the owner's email, theirs, others by name only", async () => {
  await signIn(guest, GUEST_EMAIL, GUEST_PASSWORD);
  await guest.goto(`${BASE}/p/${TEAM}`, { waitUntil: "networkidle" });
  await openShare(guest);
  const list = people(guest);
  await list.getByText(EMAIL).waitFor(); // the owner's address
  await list.getByText(GUEST_EMAIL).waitFor(); // their own
  await list.getByText("rahul (you)").waitFor();
  await list.getByText("Gina Google").waitFor();
  await list.getByText("Invited, hasn't joined yet").waitFor();
  const text = await guest.locator("body").innerText();
  assert(!text.includes(GOOGLE_EMAIL) && !text.includes("new@example.com"), "other people's emails are shown");
  assert((await guest.getByLabel("Email to invite").count()) === 0, "invite form shown");
  assert((await guest.getByLabel(/^Access for /).count()) === 0, "role menus shown");
  assert((await guest.getByLabel("General access").count()) === 0, "general access can be changed");
  await guest.getByText("Only people invited").waitFor();
  await guest.getByText("Only the owner and people with full access can change sharing.").waitFor();
  await guest.getByRole("button", { name: "Copy link" }).waitFor();
  await guest.screenshot({ path: `${SHOTS}/140-share-view-only.png` });
  await closeShare(guest);
});

await step("on a page inside, the same people are listed, with where their access comes from", async () => {
  await guest.goto(`${BASE}/p/${SUB}`, { waitUntil: "networkidle" });
  await openShare(guest);
  await people(guest).getByText("Via Team plan").first().waitFor();
  await closeShare(guest);
});

await step("the owner gives Full access", async () => {
  await setAccess(owner, GUEST_EMAIL, "Full access");
  await until(() => member(GUEST_EMAIL).can_share && member(GUEST_EMAIL).can_edit, "full access saved");
  await people(owner).getByLabel(`Access for ${GUEST_EMAIL}`).getByText("Full access").waitFor();
  await closeShare(owner);
});

await step("with full access: emails, an invite form and role menus; their own access isn't a menu", async () => {
  await guest.goto(`${BASE}/p/${TEAM}`, { waitUntil: "networkidle" });
  await openShare(guest);
  await guest.getByLabel("Email to invite").waitFor();
  await people(guest).getByText(GOOGLE_EMAIL).waitFor();
  await guest.getByLabel("Access for new@example.com").waitFor();
  assert((await guest.getByLabel(`Access for ${GUEST_EMAIL}`).count()) === 0, "can change their own access");
  assert((await guest.getByText("Only the owner and people with full access can change sharing.").count()) === 0, "read-only note shown");
  await guest.screenshot({ path: `${SHOTS}/141-share-full-access.png` });
});

await step("with full access: invite someone; the invitation goes out from them, for the owner's page", async () => {
  await invite(guest, "pal@example.com", "Can view");
  await guest.getByRole("status").filter({ hasText: "Invitation sent to pal@example.com." }).waitFor();
  const m = await until(() => member("pal@example.com"), "pal invited");
  assert(m.owner_id === UID, "invite should belong to the page's owner");
  assert(!m.can_edit, "pal should view only");
  assert(be.invitesSent.some((x) => x.email === "pal@example.com" && x.by === GUEST_UID), "email not sent by rahul");
  await people(guest).getByText("pal@example.com").waitFor();
});

await step("with full access: change someone's access, remove someone, open it to anyone with the link", async () => {
  await setAccess(guest, GOOGLE_EMAIL, "Can view");
  await until(() => member(GOOGLE_EMAIL).can_edit === false, "gina set to view");
  await openShare(guest);
  await guest.getByLabel("Access for new@example.com").click();
  await guest.getByRole("menuitem", { name: "Remove" }).click();
  await until(() => !member("new@example.com"), "new removed");
  await openShare(guest);
  await guest.getByLabel("General access").click();
  await guest.getByRole("menuitemradio", { name: /^Anyone with the link/ }).click();
  await until(() => be.shares.has(TEAM), "link turned on");
  await guest.getByLabel("Link access").waitFor();
  await closeShare(guest);
});

await step("the owner sees what the full-access person changed", async () => {
  // Reload once syncing is done: a request cut off by the reload would log an error.
  await sidebar(owner).getByText("Saved", { exact: true }).waitFor();
  await owner.reload({ waitUntil: "networkidle" });
  await openShare(owner);
  await people(owner).getByText("pal@example.com").waitFor();
  assert((await people(owner).getByText("new@example.com").count()) === 0, "removed person still listed");
  await owner.getByText("Anyone with the link").first().waitFor();
  await closeShare(owner);
});

await browser.close();
for (const r of results) console.log(r.join(" "));
console.log(errors.length ? errors : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
