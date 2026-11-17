"use strict";
// The Claude desktop app runtime (skills/hub/references/claude-app.md): the hub picks it by itself,
// preflight checks the app instead of Orca, and sync.cjs reads workers' transcripts instead of Orca's inbox.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const skillDir = path.join(root, "skills", "hub");
const read = f => fs.readFileSync(f, "utf8");

test("SKILL.md decides the runtime first and points the app to claude-app.md", () => {
  const runtime = read(path.join(skillDir, "SKILL.md")).match(/\n## Runtime\n([\s\S]*?)(?=\n## )/);
  assert.ok(runtime, "SKILL.md has no '## Runtime' section");
  assert.match(runtime[1], /`mcp__ccd_session__start_session`/);
  assert.match(runtime[1], /\[references\/claude-app\.md\]\(references\/claude-app\.md\)/);
  assert.match(runtime[1], /without `runtime` is an Orca hub/);
});

test("preflight --runtime claude-app checks the app, not Orca", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bin-"));
  try {
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\necho "git version 2.40.0"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\necho "  ✓ Logged in to github.com account octo (keyring)"\n', { mode: 0o755 });
    const r = spawnSync(process.execPath, [path.join(skillDir, "scripts", "preflight.cjs"), "--runtime", "claude-app"],
      { env: { PATH: bin, HOME: home }, encoding: "utf8", timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stdout);
    assert.match(r.stdout.trim(), /^ok: claude-app, gh octo, node v\d+\.\d+\.\d+, git 2\.40\.0$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("sync.cjs --once on a claude-app hub reads a worker's transcript into live.js", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  try {
    const hub = path.join(dir, "hub"), projects = path.join(dir, "projects"), worktree = "/w/app/.claude/worktrees/s1";
    fs.mkdirSync(hub);
    fs.copyFileSync(path.join(skillDir, "templates", "sync.cjs"), path.join(hub, "sync.cjs"));
    fs.writeFileSync(path.join(hub, "state.js"), `window.HUB_STATE = ${JSON.stringify({
      runtime: "claude-app", lastMsgAt: "2026-11-17T05:00:30Z", workers: [{ item: "S1", path: worktree }],
      lanes: [{ items: [{ id: "S1", status: "active" }] }]
    })};`);
    const tdir = path.join(projects, worktree.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(tdir, { recursive: true });
    const send = (id, at, message) => ({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to: "local_hub", message } }] } });
    const done = (id, at) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    fs.writeFileSync(path.join(tdir, "t.jsonl"), [
      send("a", "2026-11-17T05:00:00Z", "VERA status S1 phase=red: red\nSUMMARY: 이미 반영된 상태"), done("a", "2026-11-17T05:00:01Z"),
      send("b", "2026-11-17T05:01:00Z", "VERA status S1 phase=green: green\nSUMMARY: 시험 6건이 통과합니다"), done("b", "2026-11-17T05:01:01Z"),
      send("c", "2026-11-17T05:02:00Z", "VERA ask S1: ready for review: w1. Head abc."), done("c", "2026-11-17T05:02:01Z"),
      { type: "assistant", timestamp: "2026-11-17T05:02:05Z", message: { content: [{ type: "text", text: "Asked the hub; ending my turn." }] } }
    ].map(o => JSON.stringify(o)).join("\n") + "\n");
    execFileSync(process.execPath, [path.join(hub, "sync.cjs"), "--once"], { env: { ...process.env, VERA_TRANSCRIPTS: projects }, encoding: "utf8" });
    const live = new Function("window", `${read(path.join(hub, "live.js"))}; return window.HUB_LIVE;`)({});
    assert.strictEqual(live.workers.S1.state, "idle");
    assert.strictEqual(live.workers.S1.say, "Asked the hub; ending my turn.");
    assert.strictEqual(live.hub.count, 2, "only the messages after lastMsgAt are not handled yet");
    assert.strictEqual(live.hub.items.S1.last.type, "ask");
    assert.strictEqual(live.hub.items.S1.phase, "green");
    assert.deepStrictEqual(live.hub.notes.S1, { text: "시험 6건이 통과합니다", at: "2026-11-17T05:01:00Z", fresh: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
