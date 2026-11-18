#!/usr/bin/env node
/* The changed-lines hash of a PR: one hash of its file names, added and removed lines, and binary or mode changes.
   Usage: node <hub>/diffhash.cjs <dir> origin/<base> <head>   (<head> is HEAD before the push, origin/<branch> after it)
   Prints the 40-character hash and exits 0, or prints one line "cannot hash: <reason>" and exits 2, never a hash.
   It runs `git diff --no-ext-diff --no-color --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head>` with
   core.quotePath=false, keeps the lines starting with "diff --git", "+", "-", "Binary files", "old mode", or "new mode",
   and hashes them as a git blob: byte for byte the hash of the shell pipeline older hubs recorded. */
"use strict";
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const fail = reason => { console.log(`cannot hash: ${reason}`); process.exit(2); };
const args = process.argv.slice(2);
if (args.length !== 3 || args.some(a => !a)) fail("usage: node diffhash.cjs <dir> origin/<base> <head>");
const [dir, base, head] = args;
const git = (...a) => execFileSync("git", ["-c", "core.quotePath=false", "-C", dir, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const ok = (...a) => { try { return git(...a).toString().trim(); } catch { return null; } };

if (ok("rev-parse", "--is-inside-work-tree") !== "true") fail(`${dir} is not a git work tree`);
for (const ref of [base, head]) if (!ok("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) fail(`${ref} is not a commit in ${dir} (run git fetch origin, or check the name)`);
let raw;
try { raw = git("diff", "--no-ext-diff", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", `${base}...${head}`); }
catch (e) { fail(`git diff ${base}...${head} failed in ${dir}: ${String(e.stderr || "").trim().split("\n")[0] || "no message"}`); }

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
