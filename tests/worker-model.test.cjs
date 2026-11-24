"use strict";
// references/worker-model.md: the hub chooses each worker's model and effort by itself, from what the agent offers
// when the hub runs. These tests keep the instructions free of model names, so a new model needs no new release,
// and keep the bounds of the choice in place.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const skillDir = path.join(__dirname, "..", "skills", "hub");
const read = f => fs.readFileSync(path.join(skillDir, f), "utf8");
const rule = read("references/worker-model.md");
const skill = read("SKILL.md");

test("no instruction or template names a model", () => {
  const files = ["../../README.md", "agents/openai.yaml", "SKILL.md", "templates/state.js", ...fs.readdirSync(path.join(skillDir, "references")).map(n => `references/${n}`)];
  // Model families and versioned names of the agents the hub starts. `--model <model>` and the word "model" are fine.
  const named = /\b(opus|sonnet|haiku|fable|mythos|gpt-[\w.]+|o\d\b)/i;
  for (const f of files) {
    const hit = read(f).split("\n").map((l, i) => [i + 1, l.match(named)]).filter(([, m]) => m);
    assert.deepStrictEqual(hit.map(([n, m]) => `${f}:${n} ${m[0]}`), [], "a model name in the instructions goes stale when a new model ships");
  }
});

test("the hub looks the models up each session and passes an alias or a listed slug", () => {
  assert.match(rule, /Look it up once in each hub session \(a new hub, and again on every resume\)/);
  assert.match(rule, /Never take a model name from memory, from this file, or from an older `state\.js`/);
  assert.match(rule, /\| Claude \| `claude --help`[^\n]*An alias, never a full model name/);
  assert.match(rule, /\| Codex \| `codex debug models`[^\n]*`visibility` is `list`[^\n]*previous generation or legacy/);
  assert.match(rule, /When the lookup fails, or the agent is another one, start the worker with neither `--model` nor `--effort`/);
  // Codex has no alias: the newest generation is read from the list, and an unknown name never lowers the baseline.
  assert.match(rule, /keep only the newest generation: the entries whose slug carries the highest version number in the list/);
  assert.match(rule, /A name whose place you do not know counts as the most capable/);
  assert.match(rule, /again whenever you no longer hold the result \(after a compaction\)/);
});

test("the hub decides alone and only the developer's own words override it", () => {
  assert.match(rule, /Do not ask the developer, and do not leave the choice to the worker/);
  assert.match(rule, /If the developer names a model or an effort, for the run or for one item, use what they named and record it as an `answered` decision/);
  // A hub started before this rule recorded a model as a kept default: that is not the developer naming one.
  assert.match(rule, /A model that an older hub's standing choices listed as a default and the developer only kept is not one they named/);
  assert.match(read("references/review.md"), /with the model and effort from \[worker-model\.md\]\(worker-model\.md\), "The reviewer"/);
  assert.match(rule, /A reviewer you start as an Orca worker[^\n]*Never a step down/);
  // The standing-choices question tells the developer who chooses; it offers no model to pick.
  assert.match(skill, /workers run `--agent claude`, and you choose each item's model and effort yourself \(\[references\/worker-model\.md\]\(references\/worker-model\.md\)\)/);
});

test("the choice stays within one step of the baseline, on one axis", () => {
  assert.match(rule, /\*\*Model\*\*: the family one below the most capable one the agent offers/);
  assert.match(rule, /\*\*Effort\*\*: `high`\./);
  assert.match(rule, /move at most one step from the baseline, on one axis only/);
  assert.match(rule, /Never move both, never two steps, and so never the lightest effort or `max`/);
  // Doubt never lowers the choice.
  assert.match(rule, /between the baseline and down, use the baseline\. When you cannot decide between the baseline and up, go up/);
  // Going down needs every condition; going up needs one.
  assert.match(rule, /\| Up \| Any of:/);
  assert.match(rule, /\| Down \| All of:/);
  assert.match(rule, /an item over the size target is split, not given a stronger model/);
});

test("the start commands carry the choice and state.js records it", () => {
  assert.match(skill, /--agent <agent> --model <model> --effort <effort> --json/);
  assert.doesNotMatch(skill, /\[--model <model>\]/);
  assert.match(skill, /The worker failed at the work itself: clean it up and start a new worker one step up \(references\/worker-model\.md, "A replacement worker"\)/);
  assert.match(rule, /an item that ran a step down gets the baseline, and an item at the baseline goes up/);
  assert.match(rule, /An item that was already one step up, or whose replacement also fails at the work, gets no further worker: set it `blocked`/);
  assert.match(read("references/claude-app.md"), /\| `model` \| the alias you choose for this item \(\[worker-model\.md\]\(worker-model\.md\)\)/);
  assert.match(read("templates/state.js"), /model, effort \(bookkeeping, not rendered\): what the hub chose for this worker/);
  assert.match(rule, /Orca refuses `--effort` without `--model`/);
});
