// Browser tests. Builds Margin against a fake Supabase (tests/e2e/mock.mjs answers its requests in
// the browser), serves it on :4173 and runs each suite in tests/e2e, one after another.
//
//   npm run test:e2e                  every suite
//   npm run test:e2e -- sharing roles only these
//
// Needs Playwright's Chromium (`npx playwright install chromium`), or CHROMIUM_PATH set to one.
// Screenshots go to tests/output.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const dir = new URL("./e2e/", import.meta.url).pathname;
const BASE = "http://localhost:4173";
const env = {
  ...process.env,
  VITE_SUPABASE_URL: "https://test.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  VITE_SITE_URL: "https://margin.example.com",
  VITE_TURNSTILE_SITE_KEY: "",
};
const all = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "mock.mjs").map((f) => f.slice(0, -4)).sort();
const suites = process.argv.length > 2 ? process.argv.slice(2) : all;
const unknown = suites.filter((s) => !all.includes(s));
if (unknown.length) {
  console.error(`No such suite: ${unknown.join(", ")}. Suites: ${all.join(", ")}`);
  process.exit(1);
}

mkdirSync(new URL("./output/shots/", import.meta.url), { recursive: true });
const vite = (...args) => [new URL("../node_modules/vite/bin/vite.js", import.meta.url).pathname, ...args];
const build = spawnSync(process.execPath, vite("build", "--outDir", ".e2e-dist", "--emptyOutDir", "--logLevel", "warn"), { cwd: root, env, stdio: "inherit" });
if (build.status !== 0) process.exit(1);

const server = spawn(process.execPath, vite("preview", "--outDir", ".e2e-dist", "--port", "4173", "--strictPort"), { cwd: root, env, stdio: "ignore" });
const deadline = Date.now() + 30_000;
while (!(await fetch(BASE).then((r) => r.ok, () => false))) {
  if (Date.now() > deadline) {
    server.kill();
    console.error(`The preview server didn't start on ${BASE}.`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

const failed = [];
for (const suite of suites) {
  console.log(`\n== ${suite}`);
  const run = spawnSync(process.execPath, [`${dir}${suite}.mjs`], { cwd: dir, env, stdio: "inherit", timeout: 600_000 });
  if (run.status !== 0) failed.push(suite);
}
server.kill();
console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : `\nAll ${suites.length} suites passed.`);
process.exit(failed.length ? 1 : 0);
