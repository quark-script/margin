import { chromium } from "playwright";
import { createBackend } from "./mock.mjs";
const SHOTS = new URL("../output", import.meta.url).pathname;
const SITE = "https://margin.example.com";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const results = [];
const step = async (n, fn) => { try { await fn(); results.push(["✓", n]); } catch (e) { results.push(["✗", n, String(e.message).split("\n")[0]]); } };
const be = createBackend(); be.signupsOpen = true;
const ctx = await b.newContext(); await be.install(ctx); const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:4173/login", { waitUntil: "networkidle" });

await step("sign-in screen offers 'Create an account'", async () => {
  await p.getByRole("button", { name: "Create an account" }).click();
  await p.getByRole("heading", { name: "Create your account" }).waitFor();
});
await step("password shorter than 8 is blocked in the form", async () => {
  await p.getByLabel("Email").fill("new.person@example.com");
  await p.getByLabel("Password").fill("short");
  await p.getByRole("button", { name: "Create account" }).click();
  if (be.signups !== 0) throw new Error("request sent with short password");
});
await step("sign up -> 'Check your email', redirect back to Margin", async () => {
  await p.getByLabel("Password").fill("a-long-password");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByRole("heading", { name: "Check your email" }).waitFor();
  await p.getByText("new.person@example.com").waitFor();
  if (!be.lastSignup.redirect?.startsWith(SITE)) throw new Error("redirect_to: " + be.lastSignup.redirect);
  await p.screenshot({ path: `${SHOTS}/42-check-email.png` });
});
await step("resend the link", async () => {
  await p.getByRole("button", { name: "Send the link again" }).click();
  await p.getByText("Sent again").waitFor();
  if (be.resends !== 1) throw new Error("resend not called");
});
await step("back to sign in", async () => {
  await p.getByRole("button", { name: "Back to sign in" }).click();
  await p.getByRole("heading", { name: "Sign in to Margin" }).waitFor();
});
await step("expired link shows a clear message", async () => {
  await p.goto("about:blank");
  await p.goto("http://localhost:4173/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired", { waitUntil: "networkidle" });
  await p.getByText("That link has expired or was already used").waitFor();
  if (p.url().includes("#")) throw new Error("hash not cleaned: " + p.url());
});
await step("closed sign-ups show a friendly message", async () => {
  be.signupsOpen = false;
  await p.getByRole("button", { name: "Create an account" }).click();
  await p.getByLabel("Email").fill("x@example.com"); await p.getByLabel("Password").fill("a-long-password");
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByText("New sign-ups are closed right now.").waitFor();
});
const fresh = async (path) => {
  const c = await b.newContext(); await be.install(c); const pg = await c.newPage();
  pg.on("pageerror", (e) => errs.push(e.message));
  await pg.goto("http://localhost:4173" + path, { waitUntil: "networkidle" });
  return pg;
};
await step("confirm link on our domain signs you in and cleans the URL", async () => {
  const pg = await fresh("/auth/confirm?token_hash=good&type=email");
  await pg.getByRole("navigation", { name: "Pages" }).waitFor();
  if (be.verified?.type !== "email" || be.verified?.token_hash !== "good") throw new Error("verify body: " + JSON.stringify(be.verified));
  if (new URL(pg.url()).pathname !== "/" || pg.url().includes("token")) throw new Error("url: " + pg.url());
  await pg.context().close();
});
await step("reset link on our domain opens 'Set a new password'", async () => {
  const pg = await fresh("/auth/confirm?token_hash=good&type=recovery");
  await pg.getByRole("heading", { name: "Set a new password" }).waitFor();
  await pg.context().close();
});
await step("used confirm link shows the expired message", async () => {
  const pg = await fresh("/auth/confirm?token_hash=used&type=email");
  await pg.getByText("That link has expired or was already used").waitFor();
  if (new URL(pg.url()).pathname !== "/") throw new Error("url: " + pg.url());
  await pg.context().close();
});
await step("new account from 'Sign in to edit': the confirm link returns to the shared page", async () => {
  const pg = await fresh("/login?next=%2Fp%2Fpage-1&intent=edit");
  await pg.getByText("Sign in or create an account to edit the shared page.").waitFor();
  await pg.goto("http://localhost:4173/auth/confirm?token_hash=good&type=email", { waitUntil: "networkidle" });
  await pg.waitForURL(/\/p\/page-1$/, { timeout: 8000 });
  await pg.context().close();
});
await step("a 'next' pointing at another site is ignored", async () => {
  const pg = await fresh("/login?next=https%3A%2F%2Fevil.example%2Fs%2Fx");
  await pg.goto("http://localhost:4173/auth/confirm?token_hash=good&type=email", { waitUntil: "networkidle" });
  await pg.getByRole("navigation", { name: "Pages" }).waitFor();
  if (!pg.url().startsWith("http://localhost:4173/")) throw new Error("left the site: " + pg.url());
  await pg.context().close();
});
await p.setViewportSize({ width: 390, height: 844 });
await p.getByRole("button", { name: "Sign in" }).last().click().catch(() => {});
await p.goto("http://localhost:4173/login", { waitUntil: "networkidle" });
await p.getByRole("button", { name: "Create an account" }).click();
await p.screenshot({ path: `${SHOTS}/43-signup-phone.png` });
await b.close();
for (const r of results) console.log(r.join(" "));
console.log(errs.length ? errs : "no errors");
process.exitCode = results.some((r) => r[0] === "✗" || r[0] === "FAIL") || errs.length ? 1 : 0;
