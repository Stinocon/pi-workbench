#!/usr/bin/env node
/**
 * check-extensions.cjs — parse-check Pi extensions with jiti (pi's own TS loader).
 *
 * Why: a TypeScript extension with a syntax error (e.g. an unescaped backtick in a
 * template literal) is NOT caught by `pi --version`/`--list-models` (they don't
 * evaluate the extension factory) but makes `pi` exit(1) at startup with "Failed to
 * load extension ... ParseError". jiti throws the ParseError at transform time, so
 * loading each file through it is the deterministic check that it will load.
 *
 * Import-resolution errors ("Cannot find module '@earendil-works/pi-*'") are expected
 * when run standalone and are ignored: only parse/syntax errors fail. Type errors are
 * not caught, but jiti does not type-check and neither does pi at load, so they cannot
 * break startup either.
 *
 * Usage:
 *   node check-extensions.cjs [dir] [-q|--quiet]
 *     dir — scan this directory recursively for .ts (default: the repo's
 *           extensions/ + subagent/). Pass ~/.pi/agent/extensions for a live check.
 *     -q  — suppress the success line (used by the shell preflight wrapper).
 *
 * Exit codes:
 *   0 — all files parse clean
 *   1 — at least one parse/syntax error (pi would fail to start)
 *   2 — jiti not found (check unavailable)
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const target = args.find((a) => !a.startsWith("-"));

function globalModuleRoots() {
  const roots = [];
  try {
    const r = execSync("npm root -g", { encoding: "utf8" }).trim();
    if (r) roots.push(r);
  } catch {
    /* npm not on PATH — fall back to hardcoded roots below */
  }
  for (const r of [
    "/opt/homebrew/lib/node_modules", // macOS (Homebrew)
    "/usr/local/lib/node_modules", // macOS (Intel) / Linux
    "/usr/lib/node_modules", // Linux distros
  ]) {
    roots.push(r);
  }
  return [...new Set(roots)];
}

function findJiti() {
  for (const root of globalModuleRoots()) {
    for (const rel of [
      "@earendil-works/pi-coding-agent/node_modules/jiti", // nested under pi
      "jiti", // hoisted
    ]) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function collectTs(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectTs(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
}

const jitiPath = findJiti();
if (!jitiPath) {
  console.error("check-extensions: jiti not found (pi not installed in a known global location).");
  process.exit(2);
}

const { createJiti } = require(jitiPath);
const jiti = createJiti(__filename);

const files = [];
if (target) {
  collectTs(target, files);
} else {
  collectTs(path.join(REPO, "extensions"), files);
  collectTs(path.join(REPO, "subagent"), files); // subagent/ is relocated to repo top level by sync
}

if (files.length === 0) {
  if (!quiet) console.log("check-extensions: no extension files found");
  process.exit(0);
}

const base = target ? target : REPO;
let parseErrors = 0;
for (const f of files) {
  try {
    jiti(f);
  } catch (err) {
    const msg = String((err && err.message) || err).split("\n")[0];
    if (/parse|syntax/i.test(msg)) {
      console.error(`  PARSE  ${path.relative(base, f)}  ->  ${msg.slice(0, 120)}`);
      parseErrors++;
    }
    // Import-resolution and other runtime errors are ignored: only parse errors fail.
  }
}

if (parseErrors > 0) {
  console.error(`check-extensions: ${parseErrors} extension(s) have parse errors — pi would fail to start.`);
  process.exit(1);
}
if (!quiet) console.log(`check-extensions: ${files.length} extension file(s) parse clean`);
process.exit(0);
