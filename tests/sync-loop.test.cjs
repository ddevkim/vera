"use strict";
// The loop itself: the sync.pid guard, a state.js that is missing for a moment, closed: true, and the claude-app page server.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const SYNC = path.join(__dirname, "..", "skills", "hub", "templates", "sync.cjs");
const STATE = closed => `window.HUB_STATE = { v: 2, runtime: "claude-app", lanes: []${closed ? ", closed: true" : ""} };\n`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(what, fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A hub folder with a copy of sync.cjs, as the hub builds it. Every process started here is killed after the test.
function hub(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-loop-")));
  const kids = [];
  fs.copyFileSync(SYNC, path.join(dir, "sync.cjs"));
  fs.writeFileSync(path.join(dir, "state.js"), STATE(false));
  fs.mkdirSync(path.join(dir, "transcripts"));
  t.after(() => { for (const k of kids) { try { k.kill("SIGKILL"); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const start = () => {
    const k = spawn(process.execPath, [path.join(dir, "sync.cjs")], { env: { ...process.env, VERA_CYCLE_MS: "100", VERA_TRANSCRIPTS: path.join(dir, "transcripts") } });
    k.out = "";
    k.stdout.on("data", d => { k.out += d; });
    k.stderr.on("data", d => { k.out += d; });
    k.done = new Promise(r => k.on("exit", code => { k.code = code; r(code); }));
    kids.push(k);
    return k;
  };
  const other = () => { const k = spawn("sleep", ["60"]); kids.push(k); return k; };
  const pid = () => { try { return Number(fs.readFileSync(path.join(dir, "sync.pid"), "utf8").trim()); } catch { return 0; } };
  return { dir, start, other, pid };
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers }, res => {
      let body = "";
      res.on("data", d => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a sync.pid left by a process that is not a sync does not stop the sync from starting", { timeout: 30000 }, async t => {
  const h = hub(t);
  fs.writeFileSync(path.join(h.dir, "sync.pid"), String(h.other().pid)); // a reboot gave the old pid to another program
  const k = h.start();
  await until("the new sync to take sync.pid", () => h.pid() === k.pid);
  assert.strictEqual(k.code, undefined, `the sync exited: ${k.out}`);
});

test("a second sync exits while the first one runs", { timeout: 30000 }, async t => {
  const h = hub(t);
  const first = h.start();
  await until("the first sync to write sync.pid", () => h.pid() === first.pid);
  const second = h.start();
  assert.strictEqual(await second.done, 0);
  assert.match(second.out, /sync already running/);
  assert.strictEqual(h.pid(), first.pid);
  assert.strictEqual(first.code, undefined, "the first sync keeps running");
});

test("a sync that no longer owns sync.pid exits and leaves the file to its owner", { timeout: 30000 }, async t => {
  const h = hub(t);
  const k = h.start();
  await until("the sync to write sync.pid", () => h.pid() === k.pid);
  const owner = h.other().pid;
  fs.writeFileSync(path.join(h.dir, "sync.pid"), String(owner)); // two syncs started at once: the later write owns the file
  assert.strictEqual(await k.done, 0);
  assert.strictEqual(h.pid(), owner);
});

test("the sync keeps running when state.js is missing for a moment, and exits when it stays missing", { timeout: 30000 }, async t => {
  const h = hub(t);
  const k = h.start();
  await until("the first cycle", () => fs.existsSync(path.join(h.dir, "live.js")));
  fs.rmSync(path.join(h.dir, "state.js"));
  await sleep(150); // at least one cycle sees no state.js
  fs.writeFileSync(path.join(h.dir, "state.js"), STATE(false));
  await sleep(700);
  assert.strictEqual(k.code, undefined, `the sync exited after a moment without state.js: ${k.out}`);
  fs.rmSync(path.join(h.dir, "state.js"));
  assert.strictEqual(await k.done, 0);
  assert.strictEqual(h.pid(), 0, "sync.pid is removed");
});

test("the sync exits and removes sync.pid once state.js has closed: true", { timeout: 30000 }, async t => {
  const h = hub(t);
  const k = h.start();
  await until("the sync to write sync.pid", () => h.pid() === k.pid);
  fs.writeFileSync(path.join(h.dir, "state.js"), STATE(true));
  assert.strictEqual(await k.done, 0);
  assert.strictEqual(h.pid(), 0);
});

test("the page server gives only this machine the hub folder's own pages", { timeout: 30000 }, async t => {
  const h = hub(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-outside-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.js"), "SECRET");
  fs.writeFileSync(path.join(h.dir, "dashboard.html"), "<p>dashboard</p>");
  fs.writeFileSync(path.join(h.dir, "notes.txt"), "notes");
  fs.symlinkSync(path.join(outside, "secret.js"), path.join(h.dir, "link.js"));
  fs.symlinkSync(outside, path.join(h.dir, "linkdir"));
  h.start();
  const port = await until("sync.port", () => { try { return Number(fs.readFileSync(path.join(h.dir, "sync.port"), "utf8")); } catch { return 0; } });

  assert.deepStrictEqual(await get(port, "/dashboard.html"), { status: 200, body: "<p>dashboard</p>" });
  assert.strictEqual((await get(port, "/")).body, "<p>dashboard</p>");
  assert.strictEqual((await get(port, "/state.js")).status, 200);
  assert.strictEqual((await get(port, "/dashboard.html", { host: "evil.example" })).status, 403, "another Host is DNS rebinding");
  assert.strictEqual((await get(port, "/state.js", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.strictEqual((await get(port, "/notes.txt")).status, 404, "only .html, .js and .md");
  assert.strictEqual((await get(port, "/%2e%2e/%2e%2e/etc/hosts")).status, 404);
  assert.strictEqual((await get(port, "/link.js")).status, 404, "a link to a file outside the hub folder");
  assert.strictEqual((await get(port, "/linkdir/secret.js")).status, 404, "a link to a folder outside the hub folder");
});
