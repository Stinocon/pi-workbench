#!/usr/bin/env node
/**
 * check-skill-yaml.cjs — every YAML file shipped in a skill must parse.
 *
 * Why this exists: `rules/it/punctuation.yaml` shipped for weeks carrying two lines of the form
 *
 *     - "È vero." / "un po' di tempo" / "perché"
 *
 * which is not valid YAML — `" / "` after a quoted scalar is a parse error. Nothing checked it, so
 * the file was read by the model as raw text and by every tooling as broken, and the failure was
 * invisible: no gate, no output, no error. A skill's rule data that cannot be parsed is a defect of
 * the same class as code that does not run.
 *
 * The parser is the `yaml` module that ships inside the Pi installation (the machine already depends
 * on it, exactly like jiti in check-anon-guard.cjs). If it cannot be located the check reports
 * "unavailable" (exit 2) rather than passing silently.
 *
 * Usage:
 *   node scripts/check-skill-yaml.cjs [root] [-q]
 *
 * Exit codes:
 *   0 — every YAML file parses
 *   1 — at least one file does not parse
 *   2 — the YAML parser could not be located (check not performed)
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");
const rootArg = args.find((a) => !a.startsWith("-"));
const ROOT = rootArg ? path.resolve(rootArg) : path.join(REPO, "skills");

function globalModuleRoots() {
  const roots = [];
  try {
    const r = execSync("npm root -g", { encoding: "utf8" }).trim();
    if (r) roots.push(r);
  } catch {
    /* npm not on PATH — fall back to the known roots below */
  }
  for (const r of [
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ]) {
    roots.push(r);
  }
  return [...new Set(roots)];
}

function findYamlParser() {
  const rels = [
    "@earendil-works/pi-coding-agent/node_modules/yaml/dist/index.js",
    "yaml/dist/index.js",
    "@earendil-works/pi-coding-agent/node_modules/yaml/package.json",
  ];
  for (const root of globalModuleRoots()) {
    for (const rel of rels) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) return rel.endsWith("package.json") ? path.join(path.dirname(p), "dist/index.js") : p;
    }
  }
  return null;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__pycache__") continue;
      walk(p, out);
    } else if (/\.ya?ml$/.test(entry) && !entry.includes(".redacted.")) {
      out.push(p);
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`check-skill-yaml: not a directory: ${ROOT}`);
    return 1;
  }
  const parserPath = findYamlParser();
  if (!parserPath) {
    console.error("check-skill-yaml: YAML parser not found (looked for the `yaml` module in the");
    console.error("check-skill-yaml: global npm roots and inside the Pi installation). Check not performed.");
    return 2;
  }
  const YAML = (await import(`file://${parserPath}`)).default;

  const files = walk(ROOT, []).sort();
  const bad = [];
  for (const f of files) {
    try {
      YAML.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      bad.push([path.relative(REPO, f), String(e.message).split("\n")[0]]);
    }
  }
  if (bad.length) {
    for (const [f, msg] of bad) console.error(`FAIL  ${f}\n      ${msg}`);
    console.error(`check-skill-yaml: ${bad.length} of ${files.length} YAML file(s) do not parse`);
    return 1;
  }
  if (!quiet) console.log(`check-skill-yaml: ${files.length} YAML file(s) parse clean`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`check-skill-yaml: ${e.message}`);
    process.exit(1);
  },
);
