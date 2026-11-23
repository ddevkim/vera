"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const WALKCHECK = path.join(__dirname, "..", "skills", "hub", "templates", "walkcheck.cjs");
// Ignore the machine's git config (signing, hooks, default branch) so the run is the same locally and on CI.
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" });

// An "origin" with one commit on main, and a clone with one feature commit that changes app.js and adds lib.js.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "walkcheck-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin"), wt = path.join(root, "wt");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "app.js"), "const a = 1;\nmodule.exports = a;\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "base");
  git(root, "clone", "-q", origin, wt);
  fs.writeFileSync(path.join(wt, "app.js"), "const a = 2;\nconst b = a + 1;\nmodule.exports = b;\n");
  fs.writeFileSync(path.join(wt, "lib.js"), "exports.x = 1;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "feature");
  const head = git(wt, "rev-parse", "--short", "HEAD").trim();
  const data = {
    item: "S9", round: 1, title: "t", head, base: "main", kind: "behaviour",
    purpose: { spec: [{ id: "C1", text: "x" }] },
    map: { layers: ["code"], nodes: [{ id: "app", label: "app", layer: "code", file: "app.js", state: "changed" },
      { id: "lib", label: "lib", layer: "code", file: "lib.js", state: "new" }], links: [{ from: "app", to: "lib", label: "uses" }] },
    flow: [{ title: "adds one", file: "app.js", line: 2, code: "const b = a + 1;\nmodule.exports = b;" }],
    files: [{ path: "app.js", added: 3, removed: 2 }, { path: "lib.js", added: 1, removed: 0 }],
  };
  return { root, wt, data };
}

function walkcheck({ root, wt }, data, base = "origin/main") {
  const file = path.join(root, "walks", "S9-w1.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "window.HUB_WALK = " + JSON.stringify(data) + ";\n");
  const r = spawnSync(process.execPath, [WALKCHECK, file, wt, base], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, diff: path.join(root, "walks", "S9-w1.diff.js") };
}

test("each walkcheck test removes its temp folder", async t => {
  let root;
  await t.test("fixture", st => { root = setup(st).root; });
  assert.strictEqual(fs.existsSync(root), false);
});

test("walkcheck prints ok and writes the diff file when the walkthrough matches the head", t => {
  const s = setup(t);
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.out, "ok\n");
  assert.strictEqual(r.code, 0);
  const diff = fs.readFileSync(r.diff, "utf8");
  assert.match(diff, /^window\.HUB_DIFF = /);
  assert.deepStrictEqual(JSON.parse(diff.slice(18).replace(/;\n$/, "")).files.map(f => f.path), ["app.js", "lib.js"]);
});

test("walkcheck fails when a flow excerpt differs from the file at that line", t => {
  const s = setup(t);
  s.data.flow[0].code = "const b = a + 2;\nmodule.exports = b;";
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /flow: app\.js:2 — the excerpt says "const b = a \+ 2;"/);
  assert.ok(!fs.existsSync(r.diff));
});

test("walkcheck fails when files omits a changed file", t => {
  const s = setup(t);
  s.data.files.pop();
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /files: lib\.js changed \(\+1 −0\) but is not listed/);
});

test("walkcheck fails when a map link names a node id that does not exist", t => {
  const s = setup(t);
  s.data.map.links.push({ from: "app", to: "ghost", label: "x" });
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /map: link app → ghost names "ghost", which is not a node id/);
});

test("walkcheck fails when the worktree has uncommitted changes", t => {
  const s = setup(t);
  fs.appendFileSync(path.join(s.wt, "lib.js"), "exports.y = 2;\n");
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /the worktree has uncommitted changes/);
});

// A check that could not run is not a problem in the walkthrough: one "cannot check:" line, exit 2, no stack trace, no diff file.
function assertCannotCheck(r, reason) {
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /^cannot check: [^\n]+\n$/);
  assert.match(r.out, reason);
  assert.ok(!/node:|^\s+at /m.test(r.out + r.err), `no stack trace: ${r.err}`);
  assert.strictEqual(r.err, "");
  assert.ok(!fs.existsSync(r.diff));
}

test("walkcheck says it cannot check when the base ref does not exist", t => {
  const s = setup(t);
  const r = walkcheck(s, s.data, "origin/nope");
  assertCannotCheck(r, /origin\/nope/);
});

test("walkcheck says it cannot check when the worktree path is not a git repo", t => {
  const s = setup(t);
  const plain = path.join(s.root, "plain");
  fs.mkdirSync(plain);
  const r = walkcheck({ ...s, wt: plain }, s.data);
  assertCannotCheck(r, /plain/);
});

test("walkcheck says it cannot check when the worktree path does not exist", t => {
  const s = setup(t);
  const gone = path.join(s.root, "gone");
  const r = walkcheck({ ...s, wt: gone }, s.data);
  assertCannotCheck(r, /gone/);
});

test("walkcheck says it cannot check when the data file does not exist", t => {
  const s = setup(t);
  const missing = path.join(s.root, "walks", "nope.js");
  const r = spawnSync(process.execPath, [WALKCHECK, missing, s.wt, "origin/main"], { env, encoding: "utf8" });
  assertCannotCheck({ code: r.status, out: r.stdout, err: r.stderr, diff: path.join(s.root, "walks", "nope.diff.js") }, /nope\.js/);
});

test("walkcheck says it cannot check when the arguments are missing", t => {
  const s = setup(t);
  const r = spawnSync(process.execPath, [WALKCHECK, path.join(s.root, "walks", "S9-w1.js")], { env, encoding: "utf8" });
  assertCannotCheck({ code: r.status, out: r.stdout, err: r.stderr, diff: path.join(s.root, "walks", "S9-w1.diff.js") }, /^cannot check: usage: walkcheck\.cjs <data\.js> <worktree> origin\/<base>\n$/);
});

test("walkcheck says it cannot check when the path is a bare repo, not a work tree", t => {
  const s = setup(t);
  const bare = path.join(s.root, "bare.git");
  git(s.root, "clone", "-q", "--bare", path.join(s.root, "origin"), bare);
  const r = walkcheck({ ...s, wt: bare }, s.data);
  assertCannotCheck(r, /bare\.git is not a git work tree/);
});

test("walkcheck says it cannot check when the path is inside .git, not a work tree", t => {
  const s = setup(t);
  const r = walkcheck({ ...s, wt: path.join(s.wt, ".git") }, s.data);
  assertCannotCheck(r, /\.git is not a git work tree/);
});

test("walkcheck says it cannot check when the base ref shares no history with the head", t => {
  const s = setup(t);
  const empty = git(s.wt, "hash-object", "-t", "tree", os.devNull).trim();
  const unrelated = git(s.wt, "commit-tree", empty, "-m", "unrelated").trim();
  git(s.wt, "update-ref", "refs/remotes/origin/unrelated", unrelated);
  const r = walkcheck(s, s.data, "origin/unrelated");
  assertCannotCheck(r, /git diff failed/);
});

test("walkcheck still reports a flow file that does not exist at the head as a problem", t => {
  const s = setup(t);
  s.data.flow[0].file = "ghost.js";
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /flow: ghost\.js:2 — the file does not exist at the head/);
  assert.ok(!/cannot check/.test(r.out));
  assert.ok(!fs.existsSync(r.diff));
});

// An entry that is not an object (null, an array, a string, a number) in a list of records is a problem in the
// walkthrough, named by where it is: exit 1 with one line each, never a stack trace. The page reads fields off each
// entry, so one such entry would leave its step blank.
test("walkcheck reports a list entry that is not an object as a problem, not a crash", t => {
  const s = setup(t);
  s.data.files.push(null);
  s.data.map.nodes.push(null);
  s.data.map.links.push("app");
  s.data.flow.push(7);
  s.data.edges = [null, { name: "empty", steps: [null] }];
  s.data.tests = [[]];
  s.data.changes = [null];
  s.data.purpose.notHere = [null];
  s.data.design = [null];
  s.data.data = [null];
  s.data.injections = [null];
  s.data.risks = [null];
  s.data.qa = [null];
  s.data.review = [{ round: 1, findings: [null] }, null];
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1, r.err);
  assert.strictEqual(r.err, "");
  const lines = r.out.split("\n");
  for (const where of ["files[2]", "map.nodes[2]", "map.links[1]", "flow[1]", "edges[0]", "edges[1].steps[0]", "tests[0]", "changes[0]",
    "purpose.notHere[0]", "design[0]", "data[0]", "injections[0]", "risks[0]", "qa[0]", "review[0].findings[0]", "review[1]"])
    assert.ok(lines.includes(`${where}: not an object`), `reports ${where}:\n${r.out}`);
  assert.ok(!fs.existsSync(r.diff));
});

test("walkcheck counts only objects as spec lines", t => {
  const s = setup(t);
  s.data.purpose.spec = [null];
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1, r.err);
  const lines = r.out.split("\n");
  assert.ok(lines.includes("purpose.spec[0]: not an object"), r.out);
  assert.ok(lines.includes("missing field: purpose.spec"), r.out);
});

test("walkcheck checks the spec entries of a docs walkthrough too, though it needs none", t => {
  const s = setup(t);
  s.data.kind = "docs";
  s.data.purpose.spec = [null];
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1, r.err);
  const lines = r.out.split("\n");
  assert.ok(lines.includes("purpose.spec[0]: not an object"), r.out);
  assert.ok(!lines.includes("missing field: purpose.spec"), r.out);
});

// `git show HEAD:<folder>` succeeds and prints the folder's listing, so an excerpt quoting a file name from it once passed.
test("walkcheck fails when a file:line names a folder", t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.wt, "src"));
  fs.writeFileSync(path.join(s.wt, "src", "x.js"), "exports.y = 1;\n");
  git(s.wt, "add", ".");
  git(s.wt, "commit", "-qm", "a folder");
  s.data.head = git(s.wt, "rev-parse", "--short", "HEAD").trim();
  s.data.files.push({ path: "src/x.js", added: 1, removed: 0 });
  assert.strictEqual(git(s.wt, "show", "HEAD:src").split("\n")[2], "x.js", "the fixture: line 3 of the folder listing is the file name");
  s.data.flow.push({ title: "a folder", file: "src", line: 3, code: "x.js" });
  const r = walkcheck(s, s.data);
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.match(r.out, /flow: src/);
});
