"use strict";
// The hub copies its templates into the hub folder in four places: the hub folder table, resume, building the
// folder, and the upgrade. A template missing from one of them is never copied there, and a resumed hub keeps
// running the old copy. These tests keep every full copy list equal to what templates/ holds.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const skillDir = path.join(__dirname, "..", "skills", "hub");
const docs = [path.join(skillDir, "SKILL.md"),
  ...fs.readdirSync(path.join(skillDir, "references")).filter(n => n.endsWith(".md")).map(n => path.join(skillDir, "references", n))];
const templates = fs.readdirSync(path.join(skillDir, "templates")).filter(n => !n.startsWith(".")).sort(); // not .DS_Store and the like
// state.js is filled once and then edited, so only building the folder copies it.
const copied = templates.filter(n => n !== "state.js");

const NAMES = "((?:`[^`]+`(?:, and |, | and )?)+)";
const LISTS = [
  new RegExp(`^\\| ${NAMES} \\| copied from this skill's \`templates/\``, "gm"), // the hub folder table
  new RegExp(`[Cc]opy ${NAMES} from (?:this skill's )?\`templates/\``, "g"), // the steps
];

// Every list of two or more files copied from templates/, with where it is.
function copyLists() {
  const out = [];
  for (const file of docs) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of LISTS) for (const m of text.matchAll(re)) {
      const names = [...m[1].matchAll(/`([^`]+)`/g)].map(n => n[1]);
      if (names.length < 2) continue; // a single file copied to repair an older hub folder, not a full list
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ at: `${path.relative(skillDir, file)}:${line}`, names, line: text.split("\n")[line - 1] });
    }
  }
  return out;
}

test("the four places that copy the templates are all found", () => {
  const at = copyLists().map(l => l.at.replace(/:\d+$/, ""));
  assert.deepStrictEqual(at.sort(), ["SKILL.md", "SKILL.md", "SKILL.md", "references/upgrade.md"],
    "a copy list was reworded so this test no longer finds it, or a new one was added: update LISTS or the expected places");
});

test("every copy list names exactly the templates in templates/", () => {
  for (const l of copyLists())
    assert.deepStrictEqual(l.names.filter(n => n !== "state.js").sort(), copied, `${l.at} copies ${l.names.join(", ")}`);
});

test("building the folder also copies state.js, and no other list does", () => {
  for (const l of copyLists()) {
    const build = l.line.includes("**Build the folder.**");
    assert.strictEqual(l.names.includes("state.js"), build, `${l.at}: ${build ? "building the folder must copy state.js" : "only building the folder copies state.js"}`);
  }
});
