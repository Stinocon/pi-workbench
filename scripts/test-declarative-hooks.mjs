#!/usr/bin/env node
/**
 * test-declarative-hooks.mjs — a LOGGING hook must not be able to block a tool call.
 *
 * Why this exists: `runHook` treated a crash or a timeout exactly like a deliberate non-zero exit,
 * and the `tool_call` handler turns that into `{block: true}`. The shipped `hooks.json` only appends
 * a line to an audit log — so a slow disk, a full disk, or a log path that is not a regular file
 * could stop the agent from running `bash` at all. Blocking is now something a hook opts into with
 * `blockOnFailure: true`; this test drives the real extension to prove both halves:
 *
 *   - an observer hook that fails (exit 1, or a timeout) does NOT block;
 *   - a hook that declared `blockOnFailure` DOES block, including on a timeout (a guard must fail
 *     closed, a logger must not stand in the way).
 *
 * `pi.exec` is mocked, so nothing is spawned and no file is written.
 *
 * Usage: node scripts/test-declarative-hooks.mjs
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function findPiNodeModules() {
  const candidates = [
    process.env.PI_NODE_MODULES,
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && existsSync(path.join(c, "typebox"))) return c;
  }
  throw new Error("pi-coding-agent node_modules not found; set PI_NODE_MODULES");
}

const PI = await findPiNodeModules();
const EXT = process.env.DECLARATIVE_HOOKS_TS
  || path.join(process.env.HOME, ".pi", "agent", "extensions", "declarative-hooks.ts");
const { createJiti } = await import(pathToFileURL(path.join(PI, "jiti", "lib", "jiti-static.mjs")).href);

let loadCount = 0;

/** Load the extension against a fake HOME holding the given hooks.json, with a mocked `pi.exec`. */
async function load(hooks, execBehaviour) {
  const home = mkdtempSync(path.join(tmpdir(), "pi-hooks-home-"));
  mkdirSync(path.join(home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "hooks.json"), JSON.stringify({ hooks }));
  // The extension is imported from a UNIQUE copy: jiti caches modules by path, so importing the same
  // file twice returned the FIRST config and every later case silently tested the wrong hooks.json.
  // Each iteration must load its own file.
  loadCount += 1;
  const extCopy = path.join(home, ".pi", "agent", "extensions", `declarative-hooks-${loadCount}.ts`);
  copyFileSync(EXT, extCopy);
  const previous = process.env.HOME;
  process.env.HOME = home; // os.homedir() honours HOME; the extension reads hooks.json at load
  try {
    const jiti = createJiti(import.meta.url, {
      alias: { "@earendil-works/pi-coding-agent": path.join(PI, "@earendil-works", "pi-coding-agent") },
    });
    const factory = await jiti.import(extCopy, { default: true });
    const handlers = {};
    factory({
      on: (ev, fn) => {
        (handlers[ev] ||= []).push(fn);
      },
      exec: execBehaviour,
    });
    return handlers;
  } finally {
    process.env.HOME = previous;
  }
}

const ok = async () => ({ code: 0, stdout: "", stderr: "" });
const nonZero = async () => ({ code: 1, stdout: "", stderr: "hook says no" });
const hang = async () => {
  throw new Error("exec timed out after 10000ms");
};

// --- an observer hook cannot block, however it fails -------------------------------------
{
  const h = await load([{ event: "tool_call", tool: "bash", command: "log it" }], hang);
  const r = await h.tool_call[0]({ toolName: "bash", input: { command: "ls" } });
  check("an observer hook that TIMES OUT does not block the tool call", r === undefined, JSON.stringify(r));
}
{
  const h = await load([{ event: "tool_call", tool: "bash", command: "log it" }], nonZero);
  const r = await h.tool_call[0]({ toolName: "bash", input: { command: "ls" } });
  check("an observer hook that exits 1 does not block the tool call", r === undefined, JSON.stringify(r));
}
{
  const h = await load(
    [{ event: "session_before_compact", command: "annotate" }],
    nonZero,
  );
  const r = await h.session_before_compact[0]();
  check("an observer hook does not cancel compaction", r === undefined, JSON.stringify(r));
}

// --- a declared guard DOES block, including on a timeout (fail closed) --------------------
{
  const h = await load(
    [{ event: "tool_call", tool: "bash", command: "guard", blockOnFailure: true }],
    nonZero,
  );
  const r = await h.tool_call[0]({ toolName: "bash", input: { command: "rm -rf /" } });
  check("a declared guard blocks on a non-zero exit", r?.block === true, JSON.stringify(r));
  check("and the operator is told why", /hook says no/.test(r?.reason ?? ""), JSON.stringify(r?.reason));
}
{
  const h = await load(
    [{ event: "tool_call", tool: "bash", command: "guard", blockOnFailure: true }],
    hang,
  );
  const r = await h.tool_call[0]({ toolName: "bash", input: { command: "ls" } });
  check("a declared guard blocks on a TIMEOUT (fail closed)", r?.block === true, JSON.stringify(r));
}
{
  const h = await load(
    [{ event: "session_before_compact", command: "guard", blockOnFailure: true }],
    nonZero,
  );
  const r = await h.session_before_compact[0]();
  check("a declared guard cancels compaction", r?.cancel === true, JSON.stringify(r));
}

// --- a healthy hook is invisible in both roles -------------------------------------------
{
  const h = await load([{ event: "tool_call", tool: "bash", command: "log it" }], ok);
  const r = await h.tool_call[0]({ toolName: "bash", input: { command: "ls" } });
  check("a hook that succeeds does not block", r === undefined, JSON.stringify(r));
}
{
  const h = await load([{ event: "tool_call", tool: "bash", command: "log it" }], ok);
  // The filter still holds: a hook scoped to `bash` is not run for `read`.
  const r = await h.tool_call[0]({ toolName: "read", input: { path: "x" } });
  check("a hook scoped to one tool is not run for another", r === undefined, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
