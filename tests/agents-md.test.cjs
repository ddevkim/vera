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

test("AGENTS.md names the check command and the Node versions CI uses", () => {
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const runs = [...ci.matchAll(/- run: (.+)/g)].map(m => m[1].trim());
  assert.deepStrictEqual(runs, ["node --test"], "ci.yml runs one command; AGENTS.md says which");
  assert.ok(agents.includes("`node --test`"), "AGENTS.md names node --test");
  const matrix = ci.match(/node: \[([^\]]+)\]/);
  assert.ok(matrix && ci.includes("node-version: ${{ matrix.node }}"), "ci.yml runs a matrix of Node versions");
  const nodes = [...matrix[1].matchAll(/"(\d+)"/g)].map(m => m[1]);
  assert.ok(nodes.length >= 2, "ci.yml runs the oldest allowed Node and a current one");
  for (const n of nodes) assert.ok(agents.includes(`Node ${n}`), `AGENTS.md says CI runs Node ${n}`);
  // The oldest Node in CI is the one README.md promises and preflight.cjs enforces.
  const oldest = String(Math.min(...nodes.map(Number)));
  assert.ok(fs.readFileSync(path.join(root, "README.md"), "utf8").includes(`\`node\` ${oldest} or newer`), `README.md allows node ${oldest} or newer`);
  assert.ok(fs.readFileSync(path.join(root, "skills", "hub", "scripts", "preflight.cjs"), "utf8").includes(`major >= ${oldest}`), `preflight.cjs refuses a node older than ${oldest}`);
});
