#!/usr/bin/env node
/* Live sync for the hub dashboard. Copied into the hub folder; never edited there.
   Every cycle (15 s after the previous one started, never overlapping) it runs, in parallel:
   - `orca worktree ps --agent-wait` (what each worker is doing, prompt waits),
   - `orca orchestration worker-list`, `task-list`, and `inbox` for the hub's Run, so it sees workers the hub has not
     written into state.js yet and worker messages the hub has not handled yet (state.js lastMsgId),
   - every 4th cycle `gh pr view` for each open PR (CI),
   and writes live.js. dashboard.html re-reads live.js every 5 s. It writes only live.js and sync.pid; state.js stays the hub's.
   With state.js runtime "claude-app" (references/claude-app.md) it reads each worker's Claude Code transcript instead of Orca
   (the newest .jsonl in the home directory's .claude/projects/<worktree path, non-alphanumerics as "-">) for its activity and the VERA messages it sent,
   and in loop mode serves the hub folder read-only on http://127.0.0.1:<port>/ (port in sync.port), because the app's
   browser pane shows file:// pages outside the project only as static snapshots.

   node <hub>/sync.cjs          loop (one instance per hub folder, guarded by sync.pid); it exits by itself once state.js has closed: true
   node <hub>/sync.cjs --once   one cycle, no lock */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFile } = require("child_process");

const HUB = __dirname;
const STATE = path.join(HUB, "state.js"), LIVE = path.join(HUB, "live.js"), PID = path.join(HUB, "sync.pid"), PORT = path.join(HUB, "sync.port");
const PROJECTS = process.env.VERA_TRANSCRIPTS || path.join(os.homedir(), ".claude", "projects"); // claude-app transcripts
const CYCLE_MS = 15000, GH_EVERY = 4, INBOX_LIMIT = 60;
const PHASE_NUM = { red: 1, green: 2, verified: 3, "pr-open": 6, "ci-green": 7 }; // status --phase → state.js phases
const FROM_WORKERS = new Set(["status", "ask", "question", "worker_done", "escalation"]);

const oneLine = (s, n) => String(s ?? "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, n);
const flat = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const arr = x => Array.isArray(x) ? x : [];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 25000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}
const result = j => (j && j.result !== undefined ? j.result : j) || {};
const errLine = (what, e) => `${what}: ${oneLine(e.stderr || e.message, 120)}`;

function readState() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(STATE, "utf8"), ctx, { timeout: 1000 });
  if (!ctx.window.HUB_STATE) throw new Error("state.js did not set window.HUB_STATE");
  return ctx.window.HUB_STATE;
}

function lastAssistantText(read) {
  const msgs = (read && read.transcript && read.transcript.messages) || [];
  const texts = msgs.filter(m => m.role === "assistant")
    .flatMap(m => (m.blocks || []).filter(b => b.type === "text" && b.text).map(b => ({ t: m.timestamp || 0, text: b.text })));
  texts.sort((a, b) => a.t - b.t);
  return texts.length ? flat(texts[texts.length - 1].text, 200) : null;
}

function ciOf(rollup) {
  let pass = 0, fail = 0, pending = 0;
  for (const c of rollup || []) {
    const st = c.__typename === "StatusContext" ? c.state : (c.status !== "COMPLETED" ? "PENDING" : c.conclusion);
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(st)) pass++;
    else if (!st || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(st)) pending++;
    else fail++; // FAILURE, ERROR, CANCELLED (blocks a required check), TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
  return { ci: !(pass + fail + pending) ? "none" : fail ? "fail" : pending ? "pending" : "pass", pass, fail, pending };
}

// Item ids in state.js; a task titled "<id>: <title>" (SKILL.md, step 6) belongs to that item.
function itemOfTitle(title, ids) {
  const m = String(title || "").match(/^([A-Za-z0-9_-]+):/);
  return m && ids.has(m[1]) ? m[1] : null;
}

// Workers the hub started but has not recorded in state.js yet, from the Run's worker list.
function discover(S, workerList, taskList, ids) {
  const known = new Set(arr(S.workers).map(w => w.dispatch).filter(Boolean));
  const titleOf = new Map(arr(result(taskList).tasks).map(t => [t.id, t.title]));
  const out = {};
  for (const w of arr(result(workerList).workers)) {
    if (known.has(w.dispatchId) || ["succeeded", "failed", "stopped", "abandoned", "released"].includes(w.state)) continue;
    const item = itemOfTitle(titleOf.get(w.taskId), ids);
    if (!item || arr(S.workers).some(x => x.item === item && x.tone !== "done")) continue;
    const ws = String(w.workspace || "");
    out[item] = { dispatch: w.dispatchId, path: ws.includes("::") ? ws.slice(ws.indexOf("::") + 2) : null, state: w.state };
  }
  return out;
}

// The "SUMMARY: <sentence>" line (protocol rule 7), also indented, in a list, or in bold.
const SUMMARY_LINE = /^[ \t>*\-\d.]*SUMMARY:[ \t*]*(.+)$/im;

// Each item's newest "SUMMARY: <sentence>" line from its worker's status and worker_done messages (protocol rule 7):
// the card shows what the PR does so far without waiting for the hub. Uses every fetched message, handled or not.
function notes(inbox, itemOf, after) {
  const out = {};
  for (const m of arr(result(inbox).messages).filter(m => ["status", "worker_done"].includes(m.type)).sort((a, b) => a.sequence - b.sequence)) {
    const hit = SUMMARY_LINE.exec(String(m.body || ""));
    const item = hit && itemOf(m);
    // fresh: the hub has not handled this message yet, so its own `done` in state.js is older than this line.
    if (item) out[item] = { text: oneLine(hit[1], 200), at: m.created_at, fresh: m.sequence > after };
  }
  return out;
}

// Worker messages newer than state.js lastMsgId: what the hub has not handled yet.
function pending(S, inbox, workerList, taskList, ids, discovered) {
  const msgs = arr(result(inbox).messages).filter(m => FROM_WORKERS.has(m.type)).sort((a, b) => a.sequence - b.sequence);
  const all = arr(result(inbox).messages);
  const last = S.lastMsgId ? all.find(m => m.id === S.lastMsgId) : null;
  // lastMsgId outside the fetched window is older than all of it; an empty one means nothing was handled yet.
  const after = last ? last.sequence : -Infinity;
  const fresh = msgs.filter(m => m.sequence > after);
  const titleOf = new Map(arr(result(taskList).tasks).map(t => [t.id, t.title]));
  const itemOfDispatch = new Map([
    ...arr(S.workers).filter(w => w.dispatch).map(w => [w.dispatch, w.item]),
    ...Object.entries(discovered).map(([item, d]) => [d.dispatch, item]),
    ...arr(result(workerList).workers).map(w => [w.dispatchId, itemOfTitle(titleOf.get(w.taskId), ids)]).filter(([, i]) => i)
  ]);
  const payload = m => { try { return JSON.parse(m.payload || "{}"); } catch { return {}; } };
  const itemOf = m => { const p = payload(m); return itemOfDispatch.get(p.dispatchId) || itemOfTitle(titleOf.get(p.taskId), ids) || itemOfTitle(m.subject, ids); };
  const items = {};
  for (const m of fresh) {
    const p = payload(m);
    const item = itemOf(m);
    if (!item) continue;
    const e = items[item] || (items[item] = { count: 0 });
    e.count++;
    e.last = { type: m.type, subject: oneLine(m.subject, 100), at: m.created_at };
    if (m.type === "status" && PHASE_NUM[p.phase] && (!e.phase || PHASE_NUM[p.phase] >= PHASE_NUM[e.phase])) e.phase = p.phase;
  }
  return {
    count: fresh.length, more: !last && !!S.lastMsgId && msgs.length >= INBOX_LIMIT,
    oldestAt: fresh.length ? fresh[0].created_at : null, items, notes: notes(inbox, itemOf, after)
  };
}

async function syncWorkers(S, ps, discovered, errors) {
  const watched = [
    ...arr(S.workers).filter(w => w.tone !== "done" && w.path),
    ...Object.entries(discovered).filter(([, d]) => d.path).map(([item, d]) => ({ item, path: d.path, dispatch: d.dispatch }))
  ];
  if (!watched.length || !ps) return {};
  const byPath = new Map(arr(result(ps).worktrees).map(r => [r.path, r]));
  const out = {};
  await Promise.all(watched.map(async w => {
    const row = byPath.get(w.path);
    if (!row) return;
    const agents = row.agents || [];
    // An agent waiting on a prompt matters most, then one that is working (a worktree can hold several agents).
    const a = agents.find(x => x.agentWait) || agents.find(x => x.state === "working") || agents[0] || {};
    const entry = {
      at: iso(Math.max(a.updatedAt || 0, row.lastActivityAt || 0)),
      state: a.state || row.status || null,
      say: a.lastAssistantMessage ? flat(a.lastAssistantMessage, 200) : null,
      tool: a.toolName ? `${a.toolName}: ${oneLine(a.toolInput, 80)}`.replace(/: $/, "") : null,
      wait: a.agentWait || null
    };
    if (!["done", "idle"].includes(entry.state) && w.dispatch) { // working or waiting on a prompt: show its latest sentence
      try { entry.say = lastAssistantText(result(await run("orca", ["orchestration", "worker-read", "--dispatch", w.dispatch, "--limit", "8", "--json"]))) || entry.say; }
      catch (e) { errors.push(errLine(`orca worker-read ${w.item}`, e)); }
    }
    out[w.item] = entry;
  }));
  return out;
}

// ---- Claude app runtime (state.js runtime: "claude-app"; references/claude-app.md) ----
const APP_WAIT_MS = 5 * 60000; // a tool call open this long may be a permission prompt
const VERA = /^VERA\s+(status|ask|question|done)\s+([A-Za-z0-9_-]+)((?:\s+[a-z]+=\S+)*)\s*:\s*(.*)$/;
const VERA_TYPE = { status: "status", ask: "ask", question: "question", done: "worker_done" }; // VERA kind → Orca type
const ms = t => { const v = Date.parse(t || ""); return Number.isFinite(v) ? v : 0; };

// One VERA message (references/claude-app.md, "Worker to hub") from the text of a SendMessage call, or null.
function parseVera(text, at) {
  const lines = String(text || "").split("\n");
  const m = (lines[0] || "").trim().match(VERA);
  if (!m) return null;
  const opts = Object.fromEntries((m[3].match(/[a-z]+=\S+/g) || []).map(kv => kv.split("=")));
  const hit = SUMMARY_LINE.exec(lines.slice(1).join("\n"));
  const subject = m[4].startsWith(`${m[2]}:`) ? m[4].slice(m[2].length + 1).trim() : m[4]; // Orca subjects already start with the id
  return { kind: m[1], item: m[2], phase: opts.phase || null, outcome: opts.outcome || null, subject, at, summary: hit ? hit[1].trim() : null };
}

// The worker's transcript: the newest top-level .jsonl in its worktree's project folder, and how many there are.
function transcriptOf(worktree) {
  const dir = path.join(PROJECTS, String(worktree).replace(/[^A-Za-z0-9]/g, "-"));
  let best = null, count = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".jsonl")) continue;
    count++;
    const p = path.join(dir, f), m = fs.statSync(p).mtimeMs;
    if (!best || m > best.m) best = { p, m };
  }
  return { dir, file: best && best.p, count };
}

// Reads only the bytes appended since the last cycle. Lines are cut at a newline byte, so a multibyte
// character split across two reads is decoded whole.
const transcripts = new Map();
function readTranscript(file) {
  let c = transcripts.get(file);
  const size = fs.statSync(file).size;
  if (!c || size < c.offset) c = { offset: 0, rest: Buffer.alloc(0), at: 0, say: null, ended: false, open: new Map(), vera: [] };
  if (size > c.offset) {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    fs.closeSync(fd);
    c.offset = size;
    const all = Buffer.concat([c.rest, buf]);
    const cut = all.lastIndexOf(0x0a) + 1;
    c.rest = all.subarray(cut);
    for (const line of all.subarray(0, cut).toString("utf8").split("\n")) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant" && o.type !== "user") continue;
      const t = ms(o.timestamp), msg = o.message || {}, content = msg.content;
      if (t) c.at = Math.max(c.at, t);
      if (o.type === "user") {
        for (const b of arr(content)) if (b.type === "tool_result") c.open.delete(b.tool_use_id);
        c.ended = false;
        continue;
      }
      for (const b of arr(content)) {
        if (b.type === "text" && b.text) c.say = flat(b.text, 200);
        if (b.type !== "tool_use") continue;
        c.open.set(b.id, { name: b.name, input: b.input || {}, t });
        if (/SendMessage$/.test(b.name || "")) {
          const v = parseVera(b.input && b.input.message, o.timestamp);
          if (v) c.vera.push(v);
        }
      }
      // Each content block is its own line, carrying its message's stop_reason: end_turn means the turn is over.
      c.ended = msg.stop_reason === "end_turn";
    }
  }
  transcripts.set(file, c);
  return c;
}

function syncAppWorkers(S, errors) {
  const workers = {}, vera = [];
  for (const w of arr(S.workers)) {
    if (!w.path || !w.item) continue;
    try {
      const found = transcriptOf(w.path);
      if (!found.file) {
        if (w.tone !== "done") errors.push(`transcript ${w.item}: none yet in ${path.basename(found.dir)}`);
        continue;
      }
      if (found.count > 1 && w.tone !== "done") errors.push(`transcript ${w.item}: ${found.count} transcripts in its folder; showing the newest`);
      const c = readTranscript(found.file);
      vera.push(...c.vera.filter(v => v.item === w.item)); // a worker reports only on its own item
      if (w.tone === "done") continue;
      const open = [...c.open.values()].sort((x, y) => y.t - x.t)[0] || null;
      const i = open ? open.input : {};
      const arg = i.command || i.file_path || i.description || i.pattern || "";
      workers[w.item] = {
        at: c.at ? new Date(c.at).toISOString() : null,
        state: open || !c.ended ? "working" : "idle",
        say: c.say,
        tool: open ? `${open.name}${arg ? `: ${oneLine(arg, 80)}` : ""}` : null,
        wait: open && open.t && Date.now() - open.t >= APP_WAIT_MS ? { source: "transcript", since: open.t, reason: null } : null
      };
    } catch (e) { errors.push(errLine(`transcript ${w.item}`, e)); }
  }
  return { workers, vera };
}

// Worker messages newer than state.js lastMsgAt, in the shape pending() gives the page for Orca.
function appPending(S, vera) {
  const ids = new Set(arr(S.lanes).flatMap(l => arr(l.items)).map(i => i.id));
  const after = ms(S.lastMsgAt);
  const msgs = vera.filter(v => ids.has(v.item)).sort((a, b) => ms(a.at) - ms(b.at));
  const fresh = msgs.filter(v => ms(v.at) > after);
  const items = {}, notesOut = {};
  for (const v of fresh) {
    const e = items[v.item] || (items[v.item] = { count: 0 });
    e.count++;
    e.last = { type: VERA_TYPE[v.kind], subject: oneLine(`${v.item}: ${v.subject}`, 100), at: v.at };
    if (v.kind === "status" && PHASE_NUM[v.phase] && (!e.phase || PHASE_NUM[v.phase] >= PHASE_NUM[e.phase])) e.phase = v.phase;
  }
  for (const v of msgs) if ((v.kind === "status" || v.kind === "done") && v.summary) notesOut[v.item] = { text: oneLine(v.summary, 200), at: v.at, fresh: ms(v.at) > after };
  return { count: fresh.length, more: false, oldestAt: fresh.length ? fresh[0].at : null, items, notes: notesOut };
}

// Read-only static server for the pages: only .html, .js, and .md files inside the hub folder.
function serve() {
  const http = require("http");
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".md": "text/plain; charset=utf-8" };
  const server = http.createServer((req, res) => {
    // Only this machine's own pages: a Host other than 127.0.0.1/localhost is DNS rebinding, and a cross-site
    // request is another site pulling state.js in with <script src>.
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(host) || req.headers["sec-fetch-site"] === "cross-site") { res.writeHead(403).end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(`http://x${req.url}`).pathname).replace(/^\/+/, "") || "dashboard.html"; }
    catch { res.writeHead(400).end(); return; }
    const file = path.resolve(HUB, rel);
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(HUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  server.on("error", e => console.error(new Date().toISOString(), "server:", e.message));
  server.listen(Number(process.env.VERA_PORT) || 0, "127.0.0.1", () => {
    fs.writeFileSync(PORT, String(server.address().port));
    console.log(`serving http://127.0.0.1:${server.address().port}/dashboard.html`);
  });
}
// ---- end of the Claude app runtime ----

async function syncPrs(S, errors) {
  const items = arr(S.lanes).flatMap(l => arr(l.items)).filter(i => i.pr && i.status !== "merged");
  const out = {};
  await Promise.all(items.map(async i => {
    try {
      const args = ["pr", "view", String(i.pr)];
      const repo = i.repo || S.repo; // an item may live in another repo than the hub's
      if (repo) args.push("--repo", repo);
      args.push("--json", "state,statusCheckRollup,mergeStateStatus,reviewDecision,headRefOid");
      const p = await run("gh", args);
      out[i.pr] = { state: p.state, merge: p.mergeStateStatus, review: p.reviewDecision || null, head: p.headRefOid, ...ciOf(p.statusCheckRollup) };
    } catch (e) { errors.push(errLine(`gh pr view ${i.pr}`, e)); }
  }));
  return out;
}

function writeLive(live) {
  const tmp = `${LIVE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `window.HUB_LIVE = ${JSON.stringify(live, null, 1)};\n`);
  fs.renameSync(tmp, LIVE); // atomic: the page never reads half a file
}

let prev = { workers: {}, prs: {}, discovered: {}, hub: null }, cycle = 0, serving = false;
async function syncOnce(withGh) {
  const started = Date.now(), errors = [];
  let S;
  try { S = readState(); }
  catch (e) { errors.push(`state.js: ${oneLine(e.message, 120)}`); writeLive({ at: new Date().toISOString(), ...prev, errors }); return null; }
  if (S.runtime === "claude-app") {
    const prs = withGh ? await syncPrs(S, errors) : prev.prs;
    const { workers, vera } = syncAppWorkers(S, errors);
    prev = { workers, prs, discovered: {}, hub: appPending(S, vera) };
    writeLive({ at: new Date().toISOString(), cycleMs: Date.now() - started, ...prev, errors });
    return S;
  }
  const ids = new Set(arr(S.lanes).flatMap(l => arr(l.items)).map(i => i.id));
  const soft = (what, p) => p.catch(e => { errors.push(errLine(what, e)); return null; });
  const runArgs = S.runId ? ["--run", S.runId, "--json"] : null;
  const [ps, workerList, taskList, inbox, prs] = await Promise.all([
    soft("orca worktree ps", run("orca", ["worktree", "ps", "--agent-wait", "--json", "--limit", "200"])),
    runArgs ? soft("orca worker-list", run("orca", ["orchestration", "worker-list", ...runArgs])) : null,
    runArgs ? soft("orca task-list", run("orca", ["orchestration", "task-list", ...runArgs])) : null,
    S.runId ? soft("orca inbox", run("orca", ["orchestration", "inbox", "--terminal", `run:${S.runId}`, "--limit", String(INBOX_LIMIT), "--json", "--full"])) : null,
    withGh ? syncPrs(S, errors) : Promise.resolve(prev.prs)
  ]);
  const discovered = workerList && taskList ? discover(S, workerList, taskList, ids) : prev.discovered;
  const workers = await syncWorkers(S, ps, discovered, errors);
  const hub = inbox ? pending(S, inbox, workerList, taskList, ids, discovered) : prev.hub;
  prev = { workers: ps ? workers : prev.workers, prs, discovered, hub };
  writeLive({ at: new Date().toISOString(), cycleMs: Date.now() - started, ...prev, errors });
  return S;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

if (require.main !== module) {
  module.exports = { notes, parseVera, appPending, transcriptOf, readTranscript }; // loaded by tests: export the pure functions, start nothing
} else if (process.argv.includes("--once")) {
  syncOnce(true).then(() => process.exit(0));
} else {
  const other = fs.existsSync(PID) ? Number(fs.readFileSync(PID, "utf8").trim()) : 0;
  if (other && other !== process.pid && alive(other)) {
    console.log(`sync already running (pid ${other})`);
    process.exit(0);
  }
  fs.writeFileSync(PID, String(process.pid));
  const stop = () => { try { if (fs.readFileSync(PID, "utf8").trim() === String(process.pid)) { fs.unlinkSync(PID); fs.rmSync(PORT, { force: true }); } } catch {} process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // One cycle at a time: the next starts CYCLE_MS after this one started, or right away when it ran longer.
  const loop = async () => {
    const t = Date.now();
    if (!fs.existsSync(STATE)) stop(); // hub folder removed
    let S = null;
    try { S = await syncOnce(cycle++ % GH_EVERY === 0); } catch (e) { console.error(new Date().toISOString(), e); }
    if (S && S.closed) stop(); // the hub set closed: true after the final sweep
    if (S && S.runtime === "claude-app" && !serving) { serving = true; serve(); } // once state.js reads as a claude-app hub
    setTimeout(loop, Math.max(0, CYCLE_MS - (Date.now() - t)));
  };
  loop();
}
