#!/usr/bin/env node
"use strict";
// Hashes the parts of this skill that a hub's protocol.md is written from, so a resumed hub can tell whether the worker
// protocol changed since it wrote protocol.md (SKILL.md, "Start or resume"). Text workers never get does not count.
//   node <this skill's folder>/scripts/protocolhash.cjs [--runtime claude-app]
// The parts: the "## protocol.md" section of references/worker-spec.md, the walkthrough template (the first js block in
// "## What the worker hands you" of references/walkthrough.md), and with --runtime claude-app the
// "## Protocol on the Claude app" section of references/claude-app.md.
// Exit 0: one line of 40 hex characters. Exit 2: one line "cannot hash: <reason>", which is not a hash.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const cannot = why => { console.log(`cannot hash: ${why}`); process.exit(2); };
const args = process.argv.slice(2);
const usage = "usage: protocolhash.cjs [--runtime claude-app]";
if (!(args.length === 0 || (args.length === 2 && args[0] === "--runtime" && ["orca", "claude-app"].includes(args[1])))) cannot(usage);
const app = args[1] === "claude-app";

const refs = path.join(__dirname, "..", "references");
const text = f => {
  try { return fs.readFileSync(path.join(refs, f), "utf8"); }
  catch (e) { return cannot(`references/${f} cannot be read (${e.code || e.message})`); }
};

// The lines from a "## <title>" heading to the next "## " heading outside a fenced block.
function section(f, title) {
  const lines = text(f).split("\n");
  const start = lines.findIndex(l => l === `## ${title}` || l.startsWith(`## ${title} `));
  if (start < 0) cannot(`references/${f} has no "## ${title}" section`);
  let fenced = false, end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("```")) fenced = !fenced;
    else if (!fenced && lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

function jsBlock(f, title) {
  const m = section(f, title).match(/^```js\n([\s\S]*?)^```$/m);
  if (!m) cannot(`references/${f} has no js block in "## ${title}"`);
  return m[1];
}

const parts = [
  ["worker-spec.md", section("worker-spec.md", "protocol.md")],
  ["walkthrough.md", jsBlock("walkthrough.md", "What the worker hands you")],
  ...(app ? [["claude-app.md", section("claude-app.md", "Protocol on the Claude app")]] : []),
];
const h = crypto.createHash("sha1");
for (const [name, body] of parts) h.update(`${name}\0${Buffer.byteLength(body)}\0${body}`);
console.log(h.digest("hex"));
