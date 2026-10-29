import { chromium } from "playwright";
import { createBackend, EMAIL, PASSWORD, UID, GUEST_EMAIL, GUEST_PASSWORD, GUEST_UID } from "./mock.mjs";

const BASE = "http://localhost:4173";
const SHOTS = new URL("../output", import.meta.url).pathname;
const results = [], errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const be = createBackend();
const now = () => new Date().toISOString();
const seed = (id, title) =>
  be.db.set(id, { id, owner_id: UID, parent_id: null, title, icon: null, content: [{ type: "paragraph", content: [{ type: "text", text: `${title} text` }] }], search_text: "", position: 0, is_favorite: false, is_archived: false, archived_at: null, created_at: now(), updated_at: now() });
const TEAM = "eeeeeeee-1111-4000-8000-000000000001", LINKED = "eeeeeeee-1111-4000-8000-000000000002";
seed(TEAM, "Team plan");
seed(LINKED, "Public notes");
be.members.push({ page_id: TEAM, owner_id: UID, email: GUEST_EMAIL, can_edit: false, can_share: false, created_at: now() });
be.shares.set(LINKED, { page_id: LINKED, token: "tok-public", can_edit: false, views: 0, last_viewed_at: null });

const opts = { viewport: { width: 1280, height: 800 } };
const ownerCtx = await browser.newContext(opts), guestCtx = await browser.newContext(opts);
await be.install(ownerCtx); await be.install(guestCtx);
const owner = await ownerCtx.newPage(), guest = await guestCtx.newPage();
for (const [who, pg] of [["owner", owner], ["guest", guest]]) {
  pg.on("pageerror", (e) => errors.push(`[${who}] ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`[${who}] ${m.text().slice(0, 160)}`));
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function until(fn, msg, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error("timed out: " + msg); }
async function step(name, fn) {
  try { await fn(); results.push(["✓", name]); }
  catch (e) {
    const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
    await owner.screenshot({ path: `${SHOTS}/FAIL-presence-owner-${slug}.png` }).catch(() => {});
    await guest.screenshot({ path: `${SHOTS}/FAIL-presence-guest-${slug}.png` }).catch(() => {});
    results.push(["✗", name, String(e?.message ?? e).split("\n")[0]]);
  }
}
const sidebar = (pg) => pg.getByRole("navigation", { name: "Pages" });
const faces = (pg) => pg.getByRole("button", { name: /on this page now|People who viewed this page/ });
async function signIn(pg, email, password) {
  await pg.goto(BASE + "/login", { waitUntil: "networkidle" });
  await pg.getByLabel("Email").fill(email); await pg.getByLabel("Password").fill(password);
  await pg.getByRole("button", { name: "Sign in" }).click();
  await sidebar(pg).waitFor();
}

await signIn(owner, EMAIL, PASSWORD);
await signIn(guest, GUEST_EMAIL, GUEST_PASSWORD);

await step("on a page shared by invite with nobody else there, no faces show", async () => {
  await owner.goto(BASE + `/p/${TEAM}`, { waitUntil: "networkidle" });
  await owner.getByLabel("Page title").waitFor();
  await owner.waitForTimeout(1500);
  assert((await faces(owner).count()) === 0, "faces shown with nobody there");
});

await step("someone invited opens it: the owner sees their face, here now, with their email on hover", async () => {
  await guest.goto(BASE + `/p/${TEAM}`, { waitUntil: "networkidle" });
  await guest.getByText("Team plan text").waitFor();
  const pile = faces(owner);
  await until(async () => (await pile.getAttribute("aria-label")) === "rahul on this page now", "owner sees the guest");
  await pile.locator("span.group").first().hover();
  const card = pile.locator("span.group").first().locator("[role=presentation]");
  await until(() => card.isVisible(), "hover card");
  const text = await card.innerText();
  assert(text.includes("rahul") && text.includes(GUEST_EMAIL) && text.includes("Here now"), "card: " + text);
  await owner.screenshot({ path: `${SHOTS}/180-presence-owner-hover.png` });
});

await step("the person invited sees the owner here now, and no history", async () => {
  const pile = faces(guest);
  await until(async () => (await pile.getAttribute("aria-label")) === "me on this page now", "guest sees the owner");
  await pile.click();
  await guest.getByRole("heading", { name: "Here now" }).waitFor();
  const pop = await guest.locator("body").innerText();
  assert(pop.includes("me (owner)") && pop.includes(EMAIL), "owner row: " + pop.slice(0, 300));
  assert(!pop.includes("Viewed this page") && !pop.includes("Only you see"), "history shown to someone invited");
  await guest.screenshot({ path: `${SHOTS}/181-presence-guest-list.png` });
  await guest.keyboard.press("Escape");
});

await step("after they leave, the owner still sees that they viewed it, faded, with when", async () => {
  await sidebar(guest).getByText("Today").click(); // leaving inside the app checks out right away
  const pile = faces(owner);
  await until(async () => (await pile.getAttribute("aria-label")) === "People who viewed this page", "guest shown as left", 12000); // by the owner's next check-in
  assert(await pile.locator(".opacity-40").count() === 1, "not faded");
  await pile.click();
  await owner.getByRole("heading", { name: "Viewed this page" }).waitFor();
  await owner.getByText("Only you see who viewed this page.").waitFor();
  const pop = await owner.locator("body").innerText();
  assert(/Viewed just now/.test(pop), "when: " + pop.slice(0, 400));
  await owner.screenshot({ path: `${SHOTS}/182-presence-owner-history.png` });
  await owner.keyboard.press("Escape");
});

await step("people invited only see who is here now: once the owner leaves, nothing", async () => {
  await sidebar(owner).getByRole("link", { name: "Public notes" }).click();
  await owner.getByText("Public notes text").waitFor();
  await guest.goto(BASE + `/p/${TEAM}`, { waitUntil: "networkidle" });
  await guest.getByText("Team plan text").waitFor();
  await guest.waitForTimeout(2500);
  assert((await faces(guest).count()) === 0, "guest sees history");
});

await step("Show when I view shared pages off: they disappear for the owner, and their views are deleted", async () => {
  await owner.goto(BASE + `/p/${TEAM}`, { waitUntil: "networkidle" });
  await until(async () => (await faces(owner).getAttribute("aria-label")) === "rahul on this page now", "guest here again");
  await guest.goto(BASE + "/settings", { waitUntil: "networkidle" });
  const sw = guest.getByRole("switch", { name: "Show when I view shared pages" });
  assert((await sw.getAttribute("aria-checked")) === "true", "starts on");
  await sw.click();
  await until(async () => (await sw.getAttribute("aria-checked")) === "false", "switched off");
  await guest.getByText("Off: you don't show up on pages people share with you", { exact: false }).waitFor();
  await until(() => ![...be.pageViews.values()].some((v) => v.user_id === GUEST_UID), "views deleted");
  await guest.goto(BASE + `/p/${TEAM}`, { waitUntil: "networkidle" });
  await guest.getByText("Team plan text").waitFor();
  await until(async () => (await faces(owner).count()) === 0, "owner still sees the guest");
  assert(![...be.pageViews.values()].some((v) => v.user_id === GUEST_UID), "a view was recorded while off");
  await guest.screenshot({ path: `${SHOTS}/183-presence-guest-hidden.png` });
});

await step("link visits are counted once per visit, without names, and the owner sees the count", async () => {
  for (let i = 0; i < 2; i++) {
    const c = await browser.newContext(opts); await be.install(c);
    const visitor = await c.newPage();
    await visitor.goto(BASE + `/p/${LINKED}`, { waitUntil: "networkidle" });
    await visitor.getByText("Public notes text").waitFor();
    await visitor.reload({ waitUntil: "networkidle" }); // same visit: not counted again
    await visitor.getByText("Public notes text").waitFor();
    await c.close();
  }
  await until(() => be.shares.get(LINKED).views === 2, "count: " + be.shares.get(LINKED).views);
  await owner.goto(BASE + `/p/${LINKED}`, { waitUntil: "networkidle" });
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await owner.getByText("Link opened 2 times, most recently just now").waitFor();
  assert(be.shares.get(LINKED).views === 2, "the owner was counted");
  assert((await faces(owner).count()) === 0, "link visitors shown as faces");
  await owner.screenshot({ path: `${SHOTS}/184-presence-link-visits.png` });
});

await browser.close();
for (const r of results) console.log(r.join(" "));
console.log(errors.length ? errors : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errors.length ? 1 : 0;
