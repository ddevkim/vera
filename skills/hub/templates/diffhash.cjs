#!/usr/bin/env node
/* The changed-lines hash of a PR: one hash of its file names, added and removed lines, the unchanged line on each side
   of every change, and binary or mode changes.
   Usage: node <hub>/diffhash.cjs [--v1] <dir> origin/<base> <head>   (<head> is HEAD before the push, origin/<branch> after it)
   Prints the 40-character hash and exits 0, or prints one line "cannot hash: <reason>" and exits 2, never a hash.
   It runs `git diff` on <base>...<head> with core.quotePath=false and the flags in FLAGS below, one line of context
   (--unified=1), keeps the lines starting with "diff --git", "+", "-", " ", "\", "Binary files", "old mode", or
   "new mode", writes each hunk header as a bare "@@" (its line numbers and function name move with the base), and
   hashes the result. The neighbouring lines say where a change sits: moving an added line past an unchanged one
   changes the hash. A rebase that git applies without a conflict keeps it, because git reports a conflict whenever
   the base changed a line that touches one of the PR's changes.
   --v1 prints the hash hubs recorded before this one: no context and no hunk marks, hashed as a git blob. Under
   default git config it is the hash of the shell pipeline the oldest hubs used (git diff ... | grep -E ... |
   git hash-object --stdin) wherever grep passed every line. A hub uses --v1 once, to tell whether a hash it holds
   in the old form still describes the PR (SKILL.md, "Resume"). The two forms never give the same hash for one diff:
   the new one hashes a "vera diffhash 2" first line.
   The flags past the pipeline's own (--submodule=short through --indent-heuristic) only pin what default config
   already gives, so diff.submodule, diff.algorithm, diff.relative, diff.orderFile, diff.context,
   diff.interHunkContext, diff.indentHeuristic, and textconv attributes cannot change the hash.
   DIFFHASH_MAX_BUFFER (bytes, default 256 MiB) caps the diff it reads. */
"use strict";
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const FLAGS = ["--no-ext-diff", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
  "--submodule=short", "--no-textconv", "--diff-algorithm=myers", "--no-relative", "-O/dev/null", "--unified=1",
  "--inter-hunk-context=0", "--indent-heuristic"];
const MAX = Number(process.env.DIFFHASH_MAX_BUFFER) || 256 * 1024 * 1024;
// A reason never carries 40 hex characters in a row, so nothing on stdout can be taken for a hash.
const fail = reason => { console.log(`cannot hash: ${reason.replace(/[0-9a-f]{40,}/gi, m => m.slice(0, 12))}`); process.exit(2); };
const args = process.argv.slice(2);
const v1 = args[0] === "--v1";
if (v1) args.shift();
if (args.length !== 3 || args.some(a => !a)) fail("usage: node diffhash.cjs [--v1] <dir> origin/<base> <head>");
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

// Bytes, not strings: a non-UTF-8 line must hash as the bytes git printed.
const starts = (line, k) => line.length >= k.length && line.subarray(0, k.length).equals(k);
const KEEP = ["diff --git", "+", "-", "Binary files", "old mode", "new mode", ...(v1 ? [] : [" ", "\\"])].map(s => Buffer.from(s));
const HUNK = Buffer.from("@@"), NL = Buffer.from("\n");
const kept = [];
let changed = false; // a context line alone is not a change
for (let i = 0; i < raw.length;) {
  let j = raw.indexOf(10, i);
  if (j < 0) j = raw.length;
  const line = raw.subarray(i, j);
  if (!v1 && starts(line, HUNK)) kept.push(HUNK, NL);
  else if (KEEP.some(k => starts(line, k))) { kept.push(line, NL); changed = true; }
  i = j + 1;
}
if (!changed) fail(`no changed lines between ${base} and ${head} in ${dir} (a PR always has some: check the refs)`);
const body = Buffer.concat(kept);
const hash = crypto.createHash("sha1");
console.log((v1 ? hash.update(`blob ${body.length}\0`) : hash.update("vera diffhash 2\n")).update(body).digest("hex"));
