"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SYNC = path.join(__dirname, "..", "skills", "hub", "templates", "sync.cjs");

// A copy in an empty folder: if loading it started the loop, it would write sync.pid there and exit, not touch templates/.
function loadInEmptyFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  try {
    fs.copyFileSync(SYNC, path.join(dir, "sync.cjs"));
    const out = execFileSync(process.execPath, ["-e", "const m = require('./sync.cjs'); setTimeout(() => console.log(typeof m.notes), 50)"], { cwd: dir, encoding: "utf8" });
    return { out: out.trim(), files: fs.readdirSync(dir), dir };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("loading sync.cjs as a module exports notes and starts no loop", () => {
  const { out, files, dir } = loadInEmptyFolder();
  assert.strictEqual(out, "function");
  assert.deepStrictEqual(files, ["sync.cjs"]);
  assert.strictEqual(fs.existsSync(dir), false, "the temp folder is removed");
});

test("node sync.cjs --once as the main module still runs a cycle", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(SYNC, path.join(dir, "sync.cjs"));
  execFileSync(process.execPath, ["sync.cjs", "--once"], { cwd: dir, encoding: "utf8" });
  // No state.js here: the cycle records that error in live.js, which only the start path writes.
  assert.match(fs.readFileSync(path.join(dir, "live.js"), "utf8"), /"state\.js: /);
});

const msg = (sequence, type, item, body) => ({ sequence, type, item, body, created_at: `t${sequence}` });
const run = (messages, after = 0) => require(SYNC).notes({ result: { messages } }, m => m.item, after);

test("notes keeps each item's newest SUMMARY line, in sequence order", () => {
  const out = run([
    msg(3, "status", "S1", "SUMMARY: 세 번째"),
    msg(1, "status", "S1", "SUMMARY: 첫 번째"),
    msg(2, "worker_done", "S2", "SUMMARY: 끝났습니다\nmore"),
  ]);
  assert.strictEqual(out.S1.text, "세 번째");
  assert.strictEqual(out.S1.at, "t3");
  assert.strictEqual(out.S2.text, "끝났습니다");
});

test("notes ignores other message types and bodies without the line", () => {
  const out = run([
    msg(1, "status", "S1", "SUMMARY: 남습니다"),
    msg(2, "ask", "S1", "SUMMARY: 질문입니다"),
    msg(3, "escalation", "S1", "SUMMARY: 막혔습니다"),
    msg(4, "status", "S1", "no summary here"),
    msg(5, "status", "S3", "nothing"),
  ]);
  assert.deepStrictEqual(Object.keys(out), ["S1"]);
  assert.strictEqual(out.S1.text, "남습니다");
});

test("notes accepts the line indented, in a list, and in bold", () => {
  for (const body of ["   SUMMARY: 가", "- SUMMARY: 가", "1. SUMMARY: 가", "**SUMMARY:** 가", "intro\n  - **SUMMARY:** 가"]) {
    assert.strictEqual(run([msg(1, "status", "S1", body)]).S1.text, "가", body);
  }
});

test("notes marks fresh only for messages after the given sequence", () => {
  const out = run([msg(4, "status", "S1", "SUMMARY: 옛것"), msg(5, "status", "S2", "SUMMARY: 새것")], 4);
  assert.strictEqual(out.S1.fresh, false);
  assert.strictEqual(out.S2.fresh, true);
});

// Measured on Orca 1.4.271: `send` to a worker that already sent worker_done (or was stopped) continues it under a new
// dispatch id and a task titled after the message's subject. Its messages carry that new id, so until the hub writes it
// into state.js only the worktree path says which item they belong to.
test("a message from a worker's follow-up dispatch counts for its item, by the worktree path", () => {
  const S = { lastMsgId: "", workers: [{ item: "W1", dispatch: "ctx_old", path: "/w/app-w1", tone: "support" }] };
  const workerList = { result: { workers: [
    { dispatchId: "ctx_new", taskId: "task_new", state: "ready", workspace: "repo-id::/w/app-w1" },
    { dispatchId: "ctx_old", taskId: "task_old", state: "succeeded", workspace: "repo-id::/w/app-w1" },
    { dispatchId: "ctx_other", taskId: "task_x", state: "ready", workspace: "repo-id::/w/elsewhere" },
  ] } };
  const taskList = { result: { tasks: [{ id: "task_new", title: "REVIEW" }, { id: "task_old", title: "W1: add the table" }, { id: "task_x", title: "REVIEW" }] } };
  const m = (sequence, dispatchId) => ({ id: `m${sequence}`, sequence, type: "worker_done", subject: "done", body: "SUMMARY: 고쳤습니다", created_at: `t${sequence}`,
    payload: JSON.stringify({ dispatchId, taskId: dispatchId === "ctx_new" ? "task_new" : "task_x" }) });
  const out = require(SYNC).pending(S, { result: { messages: [m(1, "ctx_new"), m(2, "ctx_other")] } }, workerList, taskList, new Set(["W1"]), {});
  assert.deepStrictEqual(Object.keys(out.items), ["W1"]);
  assert.strictEqual(out.items.W1.count, 1);
  assert.strictEqual(out.notes.W1.text, "고쳤습니다");
});

// A rebase notice sent to N2's worker is titled after its parent: "N1: merged, rebase onto main". The follow-up
// dispatch's task then names N1, while its worktree is N2's.
test("a follow-up dispatch whose task title names another item still counts for its own worktree's item", () => {
  const S = { lastMsgId: "", workers: [{ item: "N1", dispatch: "ctx_n1", path: "/w/n1", tone: "done" }, { item: "N2", dispatch: "ctx_n2", path: "/w/n2", tone: "support" }] };
  const workerList = { result: { workers: [null, { dispatchId: "ctx_new", taskId: "task_new", state: "ready", workspace: "r::/w/n2" }] } };
  const taskList = { result: { tasks: [{ id: "task_new", title: "N1: merged, rebase onto main" }, "junk"] } };
  const inbox = { result: { messages: [null, { id: "m1", sequence: 1, type: "status", subject: "N2: green", body: "SUMMARY: 통과", created_at: "t1",
    payload: JSON.stringify({ dispatchId: "ctx_new", taskId: "task_new", phase: "green" }) }] } };
  const ids = new Set(["N1", "N2"]);
  const sync = require(SYNC);
  assert.deepStrictEqual(sync.discover(S, workerList, taskList, ids), {}, "the follow-up dispatch is not a new worker");
  const out = sync.pending(S, inbox, workerList, taskList, ids, {});
  assert.deepStrictEqual(Object.keys(out.items), ["N2"]);
  assert.strictEqual(out.items.N2.phase, "green");
});

test("pending says more may be waiting when the fetched window is full, whatever the message types", () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, sequence: i + 1, type: i % 2 ? "status" : "dispatch", subject: "x", body: "", created_at: "t" }));
  const out = require(SYNC).pending({ lastMsgId: "gone", workers: [] }, { result: { messages } }, { result: { workers: [] } }, { result: { tasks: [] } }, new Set(), {});
  assert.strictEqual(out.more, true);
});
