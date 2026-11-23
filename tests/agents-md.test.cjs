"use strict";
// AGENTS.md is the contributors' guide that both Claude Code (through CLAUDE.md) and Codex read. These tests keep the
// paths it names real, so it does not send an agent to a file that moved.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

test("CLAUDE.md only imports AGENTS.md", () => {
  assert.strictEqual(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
});

test("every repo path AGENTS.md names exists", () => {
  const paths = [...agents.matchAll(/`([^`\s]+)`/g)].map(m => m[1])
    .filter(p => /^(\.claude-plugin|skills|tests|README\.md)(\/|$)/.test(p));
  assert.ok(paths.length >= 5, `AGENTS.md names repo paths: ${paths.join(", ")}`);
  for (const p of paths) assert.ok(fs.existsSync(path.join(root, p)), `AGENTS.md names ${p}, which does not exist`);
});

test("AGENTS.md names the check command and the Node version CI uses", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const runs = [...ci.matchAll(/- run: (.+)/g)].map(m => m[1].trim());
  assert.deepStrictEqual(runs, ["node --test"], "ci.yml runs one command; AGENTS.md says which");
  assert.ok(agents.includes("`node --test`"), "AGENTS.md names node --test");
  const node = ci.match(/node-version: "(\d+)"/);
  assert.ok(node, "ci.yml pins a Node version");
  assert.ok(agents.includes(`Node ${node[1]}`), `AGENTS.md says CI runs Node ${node[1]}`);
});
