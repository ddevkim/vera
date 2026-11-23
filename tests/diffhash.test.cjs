"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const DIFFHASH = path.join(__dirname, "..", "skills", "hub", "templates", "diffhash.cjs");
// The pipeline review.md and worker-spec.md documented before diffhash.cjs; hubs already running hold hashes made by it.
// `diffhash.cjs --v1` still prints that hash, so a hub can tell whether an old hash it holds describes the PR as it is.
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

const run = (extra, ...args) => {
  const r = spawnSync(process.execPath, [DIFFHASH, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const diffhash = (...args) => run({}, ...args);
const pipeline = (dir, base, head) => execFileSync("sh", ["-c", PIPELINE, "sh", dir, base, head], { env, encoding: "utf8" }).trim();
const hashOf = (...args) => {
  const r = diffhash(...args);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.out, /^[0-9a-f]{40}\n$/);
  return r.out.trim();
};
const v1Of = (...args) => hashOf("--v1", ...args);
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

test("diffhash --v1 prints the documented pipeline's hash for modified, added, deleted, mode, and binary changes", t => {
  const s = setup(t);
  const diff = git(s.wt, "diff", "--no-renames", "origin/main...HEAD");
  for (const want of ["old mode", "new file mode", "deleted file mode", "Binary files"]) assert.ok(diff.includes(want), want);
  const want = pipeline(s.wt, "origin/main", "HEAD");
  assert.match(want, /^[0-9a-f]{40}$/);
  assert.strictEqual(v1Of(s.wt, "origin/main", "HEAD"), want);
  assert.notStrictEqual(hashOf(s.wt, "origin/main", "HEAD"), want, "the two forms never share a hash");
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

// Writes rel under dir (making its folders); data null makes a symlink to target.
const put = (dir, rel, data, target) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.lstatSync(f); fs.rmSync(f); } catch { /* not there yet; lstat, so a dangling symlink counts as there */ }
  if (data === null) fs.symlinkSync(target, f); else fs.writeFileSync(f, data);
};
// An origin whose main holds keep.txt plus what base(dir) writes, and a clone whose feature branch commits what change(dir) does.
function build(t, base, change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diffhash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin"), wt = path.join(root, "wt");
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  put(origin, "keep.txt", "keep\n");
  base(origin);
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "base");
  git(root, "clone", "-q", origin, wt);
  git(wt, "checkout", "-qb", "feature");
  change(wt);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "feature");
  return { root, origin, wt };
}
const none = () => {};
const HEADERS = ["diff --git a/x b/x", "Binary files a/x and b/x differ", "old mode 100644", "new mode 100755", "+++ b/x", "--- a/x", "keep"];

// Parity with the documented pipeline under default config. NUL inside a text line and invalid UTF-8 are left out on purpose:
// grep implementations differ there (BSD grep passes the bytes; GNU grep, which CI runs on Ubuntu, may print a
// "binary file matches" notice instead of the lines), so the old pipeline had no single answer to agree with.
const PARITY = [
  ["a file name with a space", none, d => put(d, "a b.txt", "x\n")],
  ["a file name with a double quote", none, d => put(d, 'q"x.txt', "x\n")],
  ["a file name with a tab", none, d => put(d, "t\tx.txt", "x\n")],
  ["a non-ASCII file name", none, d => put(d, "한글 파일.txt", "x\n")],
  ["a file name with a leading -", none, d => put(d, "-dash.txt", "x\n")],
  ["content lines shaped like diff headers", d => put(d, "h.txt", HEADERS.join("\n") + "\n"),
    d => put(d, "h.txt", [...HEADERS.slice(3), ...HEADERS.slice(0, 6).map(l => l.replace(/x/g, "y"))].join("\n") + "\n")],
  ["CRLF and a lone CR", d => put(d, "cr.txt", "a\r\nb\n"), d => put(d, "cr.txt", "a\r\nc\rd\r\n")],
  ["no trailing newline", d => put(d, "nl.txt", "a\nb"), d => put(d, "nl.txt", "a\nc")],
  ["an empty file added", none, d => put(d, "empty.txt", "")],
  ["a symlink added and retargeted", d => put(d, "l1", null, "x"), d => { put(d, "l1", null, "y"); put(d, "l2", null, "z"); }],
  ["a rename (delete + add)", d => put(d, "old.txt", "same\nlines\n"), d => fs.renameSync(path.join(d, "old.txt"), path.join(d, "new.txt"))],
  ["a mode-only change", d => put(d, "run.sh", "echo\n"), d => fs.chmodSync(path.join(d, "run.sh"), 0o755)],
  ["a binary-only change", d => put(d, "b.bin", Buffer.from([0, 1, 2, 0])), d => put(d, "b.bin", Buffer.from([0, 3, 4, 0]))],
  ["<dir> given as a subdirectory", d => { put(d, "sub/a.txt", "a\n"); put(d, "top.txt", "t\n"); },
    d => { put(d, "sub/a.txt", "b\n"); put(d, "top.txt", "u\n"); }, "sub"],
];
for (const [name, base, change, sub] of PARITY) {
  test(`diffhash --v1 equals the pipeline: ${name}`, t => {
    const s = build(t, base, change);
    const dir = sub ? path.join(s.wt, sub) : s.wt;
    assert.strictEqual(v1Of(dir, "origin/main", "HEAD"), pipeline(dir, "origin/main", "HEAD"));
    hashOf(dir, "origin/main", "HEAD");
  });
}

// Each setting below changes what the plain pipeline prints (checked, so the fixture is not a no-op), and must not change diffhash.
test("diff.orderFile does not change the hash", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD"), plain = pipeline(s.wt, "origin/main", "HEAD");
  fs.writeFileSync(path.join(s.root, "order"), "run.sh\nlogo.bin\n");
  git(s.wt, "config", "diff.orderFile", path.join(s.root, "order"));
  assert.notStrictEqual(pipeline(s.wt, "origin/main", "HEAD"), plain);
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("diff.algorithm=patience does not change the hash", t => {
  // Found by search: myers removes "} g e" here, patience removes "} e g".
  const s = build(t, d => put(d, "p.txt", "e\n}\n}\ng\ng\ne\ng\na\n}\ng\n"), d => put(d, "p.txt", "e\n}\ng\ng\na\n}\ng\n"));
  const before = hashOf(s.wt, "origin/main", "HEAD"), plain = pipeline(s.wt, "origin/main", "HEAD");
  git(s.wt, "config", "diff.algorithm", "patience");
  // The fixture depends on git's diff engine: where this git gives both algorithms the same diff, there is nothing to pin.
  if (pipeline(s.wt, "origin/main", "HEAD") === plain) return t.skip("this git gives myers and patience the same diff for the fixture");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("a textconv attribute does not change the hash", t => {
  const s = setup(t);
  const before = hashOf(s.wt, "origin/main", "HEAD"), plain = pipeline(s.wt, "origin/main", "HEAD");
  fs.writeFileSync(path.join(s.wt, ".git", "info", "attributes"), "*.js diff=upper\n");
  git(s.wt, "config", "diff.upper.textconv", "sed s/e/E/g");
  assert.notStrictEqual(pipeline(s.wt, "origin/main", "HEAD"), plain);
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("diff.relative=true from a subdirectory does not change the hash", t => {
  const s = build(t, d => { put(d, "sub/a.txt", "a\n"); put(d, "top.txt", "t\n"); }, d => { put(d, "sub/a.txt", "b\n"); put(d, "top.txt", "u\n"); });
  const sub = path.join(s.wt, "sub");
  const before = hashOf(sub, "origin/main", "HEAD"), plain = pipeline(sub, "origin/main", "HEAD");
  git(s.wt, "config", "diff.relative", "true");
  assert.notStrictEqual(pipeline(sub, "origin/main", "HEAD"), plain);
  assert.strictEqual(hashOf(sub, "origin/main", "HEAD"), before);
});

test("diff.submodule=log does not hide a gitlink bump", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diffhash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subrepo = path.join(root, "subrepo"), origin = path.join(root, "origin"), wt = path.join(root, "wt");
  fs.mkdirSync(subrepo);
  git(subrepo, "init", "-q", "-b", "main");
  git(subrepo, "commit", "-q", "--allow-empty", "-m", "one");
  const one = git(subrepo, "rev-parse", "HEAD").trim();
  git(subrepo, "commit", "-q", "--allow-empty", "-m", "two");
  const two = git(subrepo, "rev-parse", "HEAD").trim();
  fs.mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  put(origin, "keep.txt", "keep\n");
  git(origin, "add", "-A");
  git(origin, "update-index", "--add", "--cacheinfo", `160000,${one},sub`);
  git(origin, "commit", "-qm", "base");
  git(root, "clone", "-q", origin, wt);
  git(wt, "checkout", "-qb", "feature");
  put(wt, "keep.txt", "kept\n");
  git(wt, "add", "keep.txt");
  git(wt, "update-index", "--cacheinfo", `160000,${two},sub`);
  git(wt, "commit", "-qm", "bump");
  const before = hashOf(wt, "origin/main", "HEAD"), plain = pipeline(wt, "origin/main", "HEAD");
  git(wt, "config", "diff.submodule", "log");
  assert.notStrictEqual(pipeline(wt, "origin/main", "HEAD"), plain);
  assert.strictEqual(hashOf(wt, "origin/main", "HEAD"), before);
});

test("a head that does not resolve fails closed", t => {
  const s = setup(t);
  failsClosed(diffhash(s.wt, "origin/main", "nope"));
});

test("a ref shaped like an option fails closed and writes no file", t => {
  const s = setup(t);
  const out = path.join(s.root, "leak");
  failsClosed(diffhash(s.wt, `--output=${out}`, "HEAD"));
  failsClosed(diffhash(s.wt, "origin/main", `--output=${out}`));
  assert.deepStrictEqual(fs.readdirSync(s.root).filter(n => n.startsWith("leak")), []);
});

test("a diff that fails after the refs resolved fails closed", t => {
  const s = setup(t);
  // The commits and trees are intact, so both refs resolve, but git diff cannot read lib.js's blob.
  const blob = git(s.wt, "rev-parse", "HEAD:lib.js").trim();
  fs.rmSync(path.join(s.wt, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  failsClosed(diffhash(s.wt, "origin/main", "HEAD"));
});

test("a diff larger than the buffer says so and names the limit", t => {
  const s = setup(t);
  const r = run({ DIFFHASH_MAX_BUFFER: "100" }, s.wt, "origin/main", "HEAD");
  failsClosed(r);
  assert.match(r.out, /larger than 100 bytes/);
  assert.match(r.out, /DIFFHASH_MAX_BUFFER/);
});

test("a failure reason never holds 40 hex characters, even glued to a word or in upper case", t => {
  const s = setup(t);
  const sha = git(s.wt, "rev-parse", "HEAD").trim();
  for (const ref of [`v${sha}`, `V${sha.toUpperCase()}`]) {
    const r = diffhash(s.wt, "origin/main", ref);
    failsClosed(r);
    assert.doesNotMatch(r.out, /[0-9a-f]{40}/i);
  }
});

// Where a change sits. app.txt holds ten numbered lines; the feature branch adds one line after line `after`.
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const withAdded = after => [...TEN.slice(0, after), "added", ...TEN.slice(after)].join("\n") + "\n";
const placed = (t, after) => build(t, d => put(d, "app.txt", TEN.join("\n") + "\n"), d => put(d, "app.txt", withAdded(after)));

test("moving an added line past an unchanged line changes the hash, which the old form missed", t => {
  const a = placed(t, 3), b = placed(t, 7);
  assert.strictEqual(v1Of(a.wt, "origin/main", "HEAD"), v1Of(b.wt, "origin/main", "HEAD"), "the old form saw only the added line");
  assert.notStrictEqual(hashOf(a.wt, "origin/main", "HEAD"), hashOf(b.wt, "origin/main", "HEAD"));
});

test("a rebase onto a base that changed a line two lines away keeps the hash", t => {
  const s = placed(t, 5); // "added" sits between line 5 and line 6
  const before = hashOf(s.wt, "origin/main", "HEAD");
  put(s.origin, "app.txt", TEN.map(l => (l === "line 4" || l === "line 7" ? `${l} changed` : l)).join("\n") + "\n");
  put(s.origin, "above.txt", "x\n");
  git(s.origin, "commit", "-qam", "nearby lines");
  git(s.wt, "fetch", "-q", "origin");
  git(s.wt, "rebase", "-q", "origin/main");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("a base that changed a line next to the PR's change makes the rebase conflict, so no clean rebase changes the hash", t => {
  for (const touched of ["line 5", "line 6"]) {
    const s = placed(t, 5);
    put(s.origin, "app.txt", TEN.map(l => (l === touched ? `${l} changed` : l)).join("\n") + "\n");
    git(s.origin, "commit", "-qam", "the neighbouring line");
    git(s.wt, "fetch", "-q", "origin");
    const r = spawnSync("git", ["rebase", "origin/main"], { cwd: s.wt, env, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, `git rebased cleanly over a change to ${touched}`);
    assert.match(r.stdout + r.stderr, /CONFLICT/);
  }
});

test("diff.context, diff.interHunkContext and diff.indentHeuristic do not change the hash", t => {
  const s = placed(t, 5);
  const before = hashOf(s.wt, "origin/main", "HEAD");
  git(s.wt, "config", "diff.context", "7");
  git(s.wt, "config", "diff.interHunkContext", "5");
  git(s.wt, "config", "diff.indentHeuristic", "false");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before);
});

test("a function name or line number in the hunk header does not change the hash", t => {
  const body = n => ["function f() {", ...Array.from({ length: n }, (_, i) => `  pad${i}();`), "  a();", "  b();", "  c();", "}"].join("\n") + "\n";
  const hashFor = (name, pad) => {
    const s = build(t, d => put(d, "f.js", body(pad).replace("f()", `${name}()`)), d => put(d, "f.js", body(pad).replace("f()", `${name}()`).replace("  b();", "  b(1);")));
    assert.match(git(s.wt, "diff", "origin/main...HEAD"), new RegExp(`@@ function ${name}\\(\\)`), "the fixture's hunk header names the function");
    return hashOf(s.wt, "origin/main", "HEAD");
  };
  assert.strictEqual(hashFor("f", 5), hashFor("g", 9));
});

test("--v1 fails closed like the new form", t => {
  const s = setup(t);
  failsClosed(diffhash("--v1", s.wt, "origin/nope", "HEAD"));
  failsClosed(diffhash("--v1", s.wt, "origin/main", "origin/main"));
  failsClosed(diffhash("--v1", s.wt, "origin/main"));
});

// A hub that was running when the hash form changed holds hashes in the old form. Without a conversion every item would
// look changed after a resume and be sent back for a walkthrough round nobody needs.
const skillDir = path.join(__dirname, "..", "skills", "hub");
const doc = f => fs.readFileSync(path.join(skillDir, f), "utf8");

test("a resumed hub converts the hashes it holds in the old form, once", () => {
  const m = doc("SKILL.md").match(/\n {3}\*\*Resume\*\* an existing hub:\n([\s\S]*?)\n2\. \*\*Read the repo/);
  const bullet = m[1].split("\n").find(l => l.startsWith("   - Hash form"));
  assert.ok(bullet, "Resume has no hash form bullet");
  assert.match(bullet, /No `hashForm: 2` in `state\.js`/);
  const order = ["with `--v1` before `<dir>`", "When it prints the item's `reviewedDiff`", "store what the command without `--v1` prints in its place",
    "leave the item's hashes", "`send` each live worker whose item has `walkApproved`", "Then set `hashForm: 2`"];
  const at = order.map(s => bullet.indexOf(s));
  at.forEach((n, i) => assert.ok(n >= 0, `the hash form bullet says: ${order[i]}`));
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, "convert, tell the workers, then record: a resume cut short converts again");
  assert.match(doc("templates/state.js"), /^ {2}hashForm: 2,/m, "a new hub starts in the current form");
  assert.match(doc("references/upgrade.md"), /Then add `hashForm: 2`/);
});

test("review.md says what the hash covers and what it cannot see", () => {
  const text = doc("references/review.md");
  assert.match(text, /the one unchanged line on each side of every change/);
  assert.match(text, /What it cannot see: a change moved between two places whose neighbouring lines are the same/);
  assert.doesNotMatch(text, /hashes them as a git blob/);
});

// What the hash must tell apart. Each pair is two feature branches over the same base; an audit found the first form of
// this hash gave both of each pair one hash, so the second could replace the first after a review.
const differ = (name, base, one, two) => test(`the hash tells apart: ${name}`, t => {
  const a = build(t, base, one), b = build(t, base, two);
  assert.notStrictEqual(hashOf(a.wt, "origin/main", "HEAD"), hashOf(b.wt, "origin/main", "HEAD"));
});
differ("two contents of a binary file", d => put(d, "b.bin", Buffer.from([0, 1, 2, 0])),
  d => put(d, "b.bin", Buffer.from("x\0reviewed")), d => put(d, "b.bin", Buffer.from("x\0EVIL")));
differ("two contents of a file a -diff attribute names", d => { put(d, ".gitattributes", "*.txt -diff\n"); put(d, "a.txt", "base\n"); },
  d => put(d, "a.txt", "SAFE\n"), d => put(d, "a.txt", "rm everything\n"));
differ("a new file that is executable and one that is not", none,
  d => put(d, "s.sh", "echo\n"), d => { put(d, "s.sh", "echo\n"); fs.chmodSync(path.join(d, "s.sh"), 0o755); });
differ("a new symlink and a new file holding its target", none,
  d => put(d, "link", null, "target"), d => put(d, "link", "target"));

test("the hash tells apart deleting an empty file and adding one", t => {
  const del = build(t, d => put(d, "e.txt", ""), d => fs.rmSync(path.join(d, "e.txt")));
  const add = build(t, none, d => put(d, "e.txt", ""));
  assert.notStrictEqual(hashOf(del.wt, "origin/main", "HEAD"), hashOf(add.wt, "origin/main", "HEAD"));
});

test("a .gitattributes the PR itself adds cannot hide its other changes", t => {
  const one = build(t, d => put(d, "a.js", "base\n"), d => { put(d, ".gitattributes", "*.js -diff\n"); put(d, "a.js", "reviewed\n"); });
  const two = build(t, d => put(d, "a.js", "base\n"), d => { put(d, ".gitattributes", "*.js -diff\n"); put(d, "a.js", "something else\n"); });
  assert.notStrictEqual(hashOf(one.wt, "origin/main", "HEAD"), hashOf(two.wt, "origin/main", "HEAD"));
});

test("diff.ignoreSubmodules=all does not hide a gitlink bump", t => {
  const s = build(t, none, d => put(d, "f.txt", "x\n"));
  const sub = path.join(s.root, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  put(sub, "a", "1\n"); git(sub, "add", "."); git(sub, "commit", "-qm", "one");
  const first = git(sub, "rev-parse", "HEAD").trim();
  put(sub, "a", "2\n"); git(sub, "commit", "-qam", "two");
  const second = git(sub, "rev-parse", "HEAD").trim();
  const withLink = sha => { git(s.wt, "update-index", "--add", "--cacheinfo", `160000,${sha},mod`); git(s.wt, "commit", "-qm", "link"); return hashOf(s.wt, "origin/main", "HEAD"); };
  const h1 = withLink(first);
  git(s.wt, "reset", "-q", "--soft", "HEAD~1");
  const h2 = withLink(second);
  assert.notStrictEqual(h1, h2);
  git(s.wt, "config", "diff.ignoreSubmodules", "all");
  assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), h2);
});

// With one line of context git joins two hunks when two or fewer unchanged lines lie between them, so a base that
// removes or adds a line between two of the PR's changes moves the hunk boundary without touching either change.
test("a clean rebase that joins or splits two hunks keeps the hash", t => {
  const TWELVE = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`);
  const edit = (lines, ...rows) => lines.map(l => (rows.includes(l) ? `${l} mine` : l)).join("\n") + "\n";
  for (const [name, baseChange] of [["joins", ls => ls.filter(l => l !== "row 7")], ["splits", ls => ls.flatMap(l => (l === "row 7" ? [l, "new a", "new b"] : [l]))]]) {
    const s = build(t, d => put(d, "t.txt", TWELVE.join("\n") + "\n"), d => put(d, "t.txt", edit(TWELVE, "row 5", "row 9")));
    const before = hashOf(s.wt, "origin/main", "HEAD");
    put(s.origin, "t.txt", baseChange(TWELVE).join("\n") + "\n");
    git(s.origin, "commit", "-qam", "between the two changes");
    git(s.wt, "fetch", "-q", "origin");
    git(s.wt, "rebase", "-q", "origin/main");
    assert.strictEqual(hashOf(s.wt, "origin/main", "HEAD"), before, `a base change that ${name} the hunks`);
  }
});
