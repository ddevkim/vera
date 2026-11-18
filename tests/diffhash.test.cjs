"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const DIFFHASH = path.join(__dirname, "..", "skills", "hub", "templates", "diffhash.cjs");
// The pipeline review.md and worker-spec.md documented before diffhash.cjs; hubs already running hold hashes made by it.
const PIPELINE = "git -c core.quotePath=false -C \"$1\" diff --no-ext-diff --no-color --no-renames --src-prefix=a/ --dst-prefix=b/ \"$2...$3\" | grep -E '^(diff --git|[+-]|Binary files|old mode|new mode)' | git hash-object --stdin";
// Ignore the machine's git config (signing, hooks, default branch) so the run is the same locally and on CI.
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" });
const HEX40 = /[0-9a-f]{40}/;

// An "origin" whose main has app.js, old.js, run.sh, and logo.bin, and a clone whose feature branch modifies app.js,
// adds lib.js, deletes old.js, makes run.sh executable, and changes the binary logo.bin.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diffhash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin"), wt = path.join(root, "wt");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "app.js"), "const a = 1;\nmodule.exports = a;\n");
  fs.writeFileSync(path.join(origin, "old.js"), "exports.old = true;\n");
  fs.writeFileSync(path.join(origin, "run.sh"), "echo hi\n");
  fs.writeFileSync(path.join(origin, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "base");
  git(root, "clone", "-q", origin, wt);
  git(wt, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(wt, "app.js"), "const a = 2;\nconst b = a + 1;\nmodule.exports = b;\n");
  fs.writeFileSync(path.join(wt, "lib.js"), "exports.x = 1;\n");
  fs.rmSync(path.join(wt, "old.js"));
  fs.chmodSync(path.join(wt, "run.sh"), 0o755);
  fs.writeFileSync(path.join(wt, "logo.bin"), Buffer.from([0, 9, 8, 7, 255, 0]));
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature");
  return { root, origin, wt };
}

const diffhash = (...args) => {
  const r = spawnSync(process.execPath, [DIFFHASH, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const pipeline = (dir, base, head) => execFileSync("sh", ["-c", PIPELINE, "sh", dir, base, head], { env, encoding: "utf8" }).trim();
const hashOf = (...args) => {
  const r = diffhash(...args);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /^[0-9a-f]{40}\n$/);
  return r.out.trim();
};
const failsClosed = (r) => {
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /^cannot hash: /);
  assert.strictEqual(r.out.split("\n").filter(Boolean).length, 1, r.out);
  assert.doesNotMatch(r.out + r.err, HEX40);
  assert.doesNotMatch(r.out + r.err, /\n\s+at /, "no stack trace");
};

test("each diffhash test removes its temp folder", async t => {
  let root;
  await t.test("fixture", st => { root = setup(st).root; });
  assert.strictEqual(fs.existsSync(root), false);
});

test("diffhash prints the documented pipeline's hash for modified, added, deleted, mode, and binary changes", t => {
  const s = setup(t);
  const diff = git(s.wt, "diff", "--no-renames", "origin/main...HEAD");
  for (const want of ["old mode", "new file mode", "deleted file mode", "Binary files"]) assert.ok(diff.includes(want), want);
  const want = pipeline(s.wt, "origin/main", "HEAD");
  assert.match(want, /^[0-9a-f]{40}$/);
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), want);
});

test("a clean rebase onto a newer base keeps the hash", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD");
  fs.writeFileSync(path.join(s.origin, "other.js"), "exports.other = 1;\n");
  git(s.origin, "add", ".");
  git(s.origin, "commit", "-qm", "unrelated");
  git(s.wt, "fetch", "-q", "origin");
  git(s.wt, "rebase", "-q", "origin/main");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("editing one of the branch's own lines changes the hash", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD");
  fs.writeFileSync(path.join(s.wt, "lib.js"), "exports.x = 2;\n");
  git(s.wt, "commit", "-qam", "fix");
  assert.notStrictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("repo git config that changes diff output does not change the hash", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD");
  git(s.wt, "config", "diff.noprefix", "true");
  git(s.wt, "config", "color.ui", "always");
  git(s.wt, "config", "diff.renames", "true");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("origin/<branch> after the push gives the hash HEAD gave before it", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD");
  git(s.wt, "push", "-q", "origin", "feature");
  assert.strictEqual(hashOf(s.wt, "origin/main", "origin/feature"), before);
});

test("a base ref that was never fetched fails closed", t => {
  const s = setup(t);
  failsClosed(diffhash(s.wt, "origin/nope", "HEAD"));
});

test("a folder that is not a git work tree fails closed", t => {
  const s = setup(t);
  const plain = path.join(s.root, "plain");
  fs.mkdirSync(plain);
  failsClosed(diffhash(plain, "origin/main", "HEAD"));
  failsClosed(diffhash(path.join(s.root, "missing"), "origin/main", "HEAD"));
});

test("no changed lines between base and head fails closed", t => {
  const s = setup(t);
  failsClosed(diffhash(s.wt, "origin/main", "origin/main"));
});

test("a wrong argument count prints usage and exits 2", t => {
  const s = setup(t);
  failsClosed(diffhash(s.wt, "origin/main"));
  failsClosed(diffhash());
  failsClosed(diffhash(s.wt, "origin/main", "HEAD", "extra"));
});
