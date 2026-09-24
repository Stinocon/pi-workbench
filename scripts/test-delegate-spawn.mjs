#!/usr/bin/env node
/**
 * test-delegate-spawn.mjs — the worker-spawn failure paths of `delegate`, driven for real.
 *
 * Why this exists: `runWorker` reports four different failures, and for a while three of them were
 * wrong — a child killed by a signal (exit code null) was reported as "completed", an external kill
 * was reported as "a timeout", and an aborted delegation left the worker running to its own timeout.
 * None of it was reachable from `test-delegate.mjs`, which never spawns anything.
 *
 * The worker here is a STUB, not a model: `PI_DELEGATE_SPAWN` (a test seam in `getPiInvocation`)
 * points the spawn at a small wrapper that ignores the pi arguments and dies in a controlled way.
 * No network, no provider, no cost.
 *
 * Usage: node scripts/test-delegate-spawn.mjs
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// --- the stub, behind a wrapper that ignores the arguments pi passes -------------------
const dir = path.join(tmpdir(), `pi-delegate-stub-${Date.now()}`);
mkdirSync(dir, { recursive: true });

const stub = path.join(dir, "stub.cjs");
writeFileSync(
  stub,
  `const mode = process.env.PI_DELEGATE_STUB || "ok";
if (mode === "kill-self") {
  process.kill(process.pid, "SIGKILL");            // the child closes with code === null
} else if (mode === "rate-limited") {
  process.stderr.write("Error: 429 rate limit exceeded\\n");
  process.exit(1);
} else if (mode === "sleep") {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model: "stub/model",
      stopReason: "end",
      content: [{ type: "text", text: "stub answer" }],
    },
  }) + "\\n");
}`,
);

const wrapper = path.join(dir, "stub.sh");
writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${stub}"\n`);
chmodSync(wrapper, 0o755);

const PI = await findPiNodeModules();
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// The repo's OWN copy: a test that drives ~/.pi/agent while claiming to gate this repository
// passes even when the repository's copy is broken — and the distribution copy lives here.
const EXT = process.env.DELEGATE_TS || path.join(REPO, path.join("extensions", "delegate.ts"));
const typeboxMain = path.join(PI, "typebox", "build", "index.mjs");
const typeboxValue = path.join(PI, "typebox", "build", "value", "index.mjs");
const typeboxCompile = path.join(PI, "typebox", "build", "compile", "index.mjs");
const piTui = path.join(PI, "@earendil-works", "pi-tui", "dist", "index.js");
const { createJiti } = await import(pathToFileURL(path.join(PI, "jiti", "lib", "jiti-static.mjs")).href);
const jiti = createJiti(import.meta.url, {
  alias: {
    typebox: typeboxMain,
    "typebox/value": typeboxValue,
    "typebox/compile": typeboxCompile,
    "@sinclair/typebox": typeboxMain,
    "@sinclair/typebox/value": typeboxValue,
    "@sinclair/typebox/compile": typeboxCompile,
    "@earendil-works/pi-tui": piTui,
  },
});

// Must be set BEFORE the module is loaded: getPiInvocation reads it at spawn time, and the module is
// loaded here anyway, so either order works — but setting it first is unambiguous.
process.env.PI_DELEGATE_SPAWN = wrapper;

const mod = await jiti.import(EXT, { default: false });
const runWorker = mod.runWorker;
if (typeof runWorker !== "function") {
  console.log("FAIL  delegate.ts does not export runWorker — the failure paths are not testable");
  process.exit(1);
}

/** Run the stub through the real `runWorker`. `runWorker(cwd, modelRef, thinking, allowRead, brief, timeoutSeconds, signal)`. */
function runStub(mode, seconds, signal) {
  process.env.PI_DELEGATE_STUB = mode;
  return runWorker(dir, "stub:model", "", false, "brief", seconds, signal);
}

// --- 1. the happy path still works -----------------------------------------------------
{
  const out = await runStub("ok", 20);
  check(
    "a clean worker run reports success with its text",
    out.ok === true && out.output === "stub answer",
    JSON.stringify({ ok: out.ok, output: out.output, error: out.error }),
  );
}

// --- 2. killed by a signal is NOT success ---------------------------------------------
{
  const out = await runStub("kill-self", 20);
  check("a worker killed by a signal is reported as FAILED", out.ok === false, JSON.stringify(out));
  check("and not as a timeout", /killed before it finished/.test(out.error ?? ""), JSON.stringify(out.error));
}

// --- 3. a non-zero exit maps to a useful error ----------------------------------------
{
  const out = await runStub("rate-limited", 20);
  check("a non-zero exit is a failure", out.ok === false, JSON.stringify(out));
  check("and a 429 is named as a rate limit", /rate-limit/.test(out.error ?? ""), JSON.stringify(out.error));
}

// --- 4. an abort reaches the worker and stops it --------------------------------------
{
  const controller = new AbortController();
  const started = Date.now();
  const promise = runStub("sleep", 30, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const out = await promise;
  const elapsed = Date.now() - started;
  check("an aborted delegation is a failure", out.ok === false, JSON.stringify(out));
  check(
    "and says the caller aborted it, not that it timed out",
    /aborted by the caller/.test(out.error ?? ""),
    JSON.stringify(out.error),
  );
  // Proof the child was killed: without the abort wiring, the promise would wait out the 30 s.
  check("and the worker was actually stopped", elapsed < 5000, `elapsed=${elapsed}ms`);
}

// --- 5. a real timeout still says timeout ---------------------------------------------
{
  const out = await runStub("sleep", 1);
  check("a timeout is a failure", out.ok === false, JSON.stringify(out));
  check(
    "and is reported as a timeout after the configured seconds",
    /timed out after 1s/.test(out.error ?? ""),
    JSON.stringify(out.error),
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
