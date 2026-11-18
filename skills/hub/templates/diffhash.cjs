#!/usr/bin/env node
/* The changed-lines hash of a PR: one hash of its file names, added and removed lines, and binary or mode changes.
   Usage: node <hub>/diffhash.cjs <dir> origin/<base> <head>   (<head> is HEAD before the push, origin/<branch> after it)
   Prints the 40-character hash and exits 0, or prints one line "cannot hash: <reason>" and exits 2, never a hash.
   It runs `git diff` on <base>...<head> with core.quotePath=false and the flags in FLAGS below, keeps the lines starting
   with "diff --git", "+", "-", "Binary files", "old mode", or "new mode", and hashes them as a git blob.
   Under default git config this is the hash of the shell pipeline older hubs recorded (git diff ... | grep -E ... |
   git hash-object --stdin) wherever grep passed every line. It did not when the diff held a text line with a NUL byte
   or, under GNU grep in a UTF-8 locale, invalid UTF-8: grep then printed a "binary file matches" notice, or nothing,
   in place of the lines, so the pipeline hashed that instead. The flags past the pipeline's own (--submodule=short
   through -O/dev/null) only pin what default config already gives, so diff.submodule, diff.algorithm, diff.relative,
   diff.orderFile, and textconv attributes cannot change the hash.
   DIFFHASH_MAX_BUFFER (bytes, default 256 MiB) caps the diff it reads. */
"use strict";
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const FLAGS = ["--no-ext-diff", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
  "--submodule=short", "--no-textconv", "--diff-algorithm=myers", "--no-relative", "-O/dev/null"];
const MAX = Number(process.env.DIFFHASH_MAX_BUFFER) || 256 * 1024 * 1024;
// A reason never carries a full object name, so nothing on stdout can be taken for a hash.
const fail = reason => { console.log(`cannot hash: ${reason.replace(/\b([0-9a-f]{12})[0-9a-f]{28,}\b/g, "$1")}`); process.exit(2); };
const args = process.argv.slice(2);
if (args.length !== 3 || args.some(a => !a)) fail("usage: node diffhash.cjs <dir> origin/<base> <head>");
const [dir, base, head] = args;
const git = (opts, ...a) => execFileSync("git", ["-c", "core.quotePath=false", "-C", dir, ...a], { maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
const ok = (...a) => { try { return git({}, ...a).toString().trim(); } catch { return null; } };

if (ok("rev-parse", "--is-inside-work-tree") !== "true") fail(`${dir} is not a git work tree`);
for (const ref of [base, head]) {
  if (ref.startsWith("-")) fail(`${ref} is not a ref (it starts with "-")`);
  if (!ok("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) fail(`${ref} is not a commit in ${dir} (run git fetch origin, or check the name)`);
}
let raw;
try { raw = git({ maxBuffer: MAX }, "diff", ...FLAGS, `${base}...${head}`); }
catch (e) {
  if (e.code === "ENOBUFS") fail(`the diff of ${base}...${head} in ${dir} is larger than ${MAX} bytes (raise DIFFHASH_MAX_BUFFER)`);
  fail(`git diff ${base}...${head} failed in ${dir}: ${String(e.stderr || e.message || "").trim().split("\n")[0] || "no message"}`);
}

// Bytes, not strings: a non-UTF-8 line must hash as the bytes grep passed on.
const KEEP = ["diff --git", "+", "-", "Binary files", "old mode", "new mode"].map(s => Buffer.from(s));
const kept = [];
for (let i = 0; i < raw.length;) {
  let j = raw.indexOf(10, i);
  if (j < 0) j = raw.length;
  const line = raw.subarray(i, j);
  if (KEEP.some(k => line.length >= k.length && line.subarray(0, k.length).equals(k))) kept.push(line, Buffer.from("\n"));
  i = j + 1;
}
if (!kept.length) fail(`no changed lines between ${base} and ${head} in ${dir} (a PR always has some: check the refs)`);
const body = Buffer.concat(kept);
console.log(crypto.createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex"));
