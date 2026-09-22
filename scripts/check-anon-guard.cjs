#!/usr/bin/env node
/**
 * check-anon-guard.cjs — RUNTIME check of the anon-guard extension (not just a parse check).
 *
 * Why this exists: `check-extensions.cjs` catches syntax errors, but anon-guard is a privacy
 * safety-net whose worst failure is *silent inaction*. A `ReferenceError` inside the guard's
 * `try { … } catch {}` (added so the guard can never break a tool call) makes every read pass
 * unchecked, while the parse check, the tests and the UI all stay green. That exact bug shipped
 * once during development and was only caught by driving the handlers — so it is now a gate.
 *
 * The script loads the extension with jiti (pi's own TS loader) against a hermetic temp
 * `ANON_HOME` (a copy of anon.py + a dummy map), drives `tool_call` / `tool_result` with a mock
 * pi, and asserts the observable behaviour: block, allow, hard-block the maps, fail-closed on
 * oversized files, `all` mode, `off`, the `/anon` command, and — separately — that a broken
 * engine produces a visible indicator AND fails open.
 *
 * Usage:
 *   node check-anon-guard.cjs [-q|--quiet]
 *
 * Exit codes:
 *   0 — all runtime checks passed
 *   1 — at least one check failed (the guard would not protect what DEC-0010 claims)
 *   2 — the check could not run (jiti / pi / ~/.anon/anon.py not found)
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const quiet = args.includes("-q") || args.includes("--quiet");

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

function findInGlobalRoots(rels) {
  for (const root of globalModuleRoots()) {
    for (const rel of rels) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const jitiPath = findInGlobalRoots(["@earendil-works/pi-coding-agent/node_modules/jiti", "jiti"]);
const piEntry = findInGlobalRoots(["@earendil-works/pi-coding-agent/dist/index.js"]);
const liveAnon = path.join(os.homedir(), ".anon", "anon.py");
const liveDeanon = path.join(os.homedir(), ".anon", "deanon.py");

if (!jitiPath || !piEntry) {
  console.error("check-anon-guard: jiti or pi not found (pi not installed in a known global location).");
  process.exit(2);
}
if (!fs.existsSync(liveAnon) || !fs.existsSync(liveDeanon)) {
  console.error(`check-anon-guard: engine not found at ${liveAnon} / ${liveDeanon} — nothing to check against.`);
  process.exit(2);
}

const source = path.join(REPO, "extensions", "anon-guard.ts");
const sourcePath = fs.existsSync(source) ? source : path.join(os.homedir(), ".pi", "agent", "extensions", "anon-guard.ts");
if (!fs.existsSync(sourcePath)) {
  console.error("check-anon-guard: anon-guard.ts not found.");
  process.exit(2);
}

const { createJiti } = require(jitiPath);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anon-guard-check-"));
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  if (!quiet) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

/** Load a variant of the extension whose ANON_HOME/ANON_PY point into the temp dir. */
async function loadVariant(name, transform) {
  const text = transform(fs.readFileSync(sourcePath, "utf8"));
  const file = path.join(tmp, `${name}.ts`);
  fs.writeFileSync(file, text);
  const jiti = createJiti(__filename, { alias: { "@earendil-works/pi-coding-agent": piEntry } });
  const factory = await jiti.import(file, { default: true });
  const handlers = {};
  const flags = { "anon-guard": "on" };
  const commands = {};
  const statuses = [];
  const toasts = [];
  const pasted = [];
  const messages = [];
  const pi = {
    on: (ev, fn) => (handlers[ev] ||= []).push(fn),
    registerFlag: (n, o) => (flags[n] = o.default),
    registerCommand: (n, o) => (commands[n] = o),
    getFlag: (n) => flags[n],
  };
  factory(pi);
  return {
    handlers,
    flags,
    commands,
    statuses,
    toasts,
    messages,
    pasted,
    ctx: {
      cwd: tmp,
      mode: "print",
      hasUI: false,
      ui: {
        notify: (m, t) => {
          toasts.push(t);
          messages.push(m);
        },
        setStatus: (k, v) => statuses.push(v),
        pasteToEditor: (text) => pasted.push(text),
      },
    },
  };
}

const pointToTemp = (text) =>
  text
    .replace('path.join(os.homedir(), ".anon")', JSON.stringify(path.join(tmp, "home")))
    .replace('const ANON_PY = path.join(ANON_HOME, "anon.py");', `const ANON_PY = ${JSON.stringify(path.join(tmp, "home", "anon.py"))};`);

function writeFixtureHome() {
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "maps"), { recursive: true });
  fs.copyFileSync(liveAnon, path.join(home, "anon.py"));
  fs.copyFileSync(liveDeanon, path.join(home, "deanon.py"));
  fs.writeFileSync(path.join(home, "entities.txt"), "CLIENTE|Acme\n");
  fs.writeFileSync(path.join(home, "maps", "dummy.map.json"), '{"entries":{}}\n');
  // A redacted document plus the map that produced it: /deanon must find it by `output` and write
  // the real values to a FILE (never into the editor).
  const redacted = path.join(tmp, "verbale.redacted.md");
  fs.writeFileSync(redacted, "Referente: [PERSONA-1-a3f9d1] <[EMAIL-1-a3f9d1]>\n");
  fs.writeFileSync(
    path.join(home, "maps", "20260922-000000-aaaaaa.map.json"),
    JSON.stringify(
      {
        tag: "a3f9d1",
        version: "1.6.0",
        schema: "anon/1",
        id: "20260922-000000-aaaaaa",
        source: "/fixture/verbale.md",
        output: redacted,
        created: "2026-09-22T00:00:00+0200",
        counts: { PERSONA: 1, EMAIL: 1 },
        entries: {
          "[PERSONA-1-a3f9d1]": { type: "PERSONA", original: "Mario Rossi" },
          "[EMAIL-1-a3f9d1]": { type: "EMAIL", original: "mario.rossi@acme.it" },
        },
      },
      null,
      2,
    ),
  );
  const sensitive = path.join(tmp, "cliente.txt");
  fs.writeFileSync(sensitive, "Cliente Acme, referente Mario Rossi <mario.rossi@acme.it>, tel +39 030 1234567, server 10.42.7.19\n");
  const clean = path.join(tmp, "note.md");
  fs.writeFileSync(clean, "Vedi anon.py, deanon.py, README.md. Contatti: user@example.com, 192.0.2.10.\n");
  const big = path.join(tmp, "big.log");
  fs.writeFileSync(big, "x");
  fs.truncateSync(big, 9 * 1024 * 1024);
  // A .docx is a ZIP: Pi's read tool decodes non-image files as UTF-8 text, so an un-scannable
  // container must be blocked rather than reported clean.
  const docx = path.join(tmp, "verbale.docx");
  fs.writeFileSync(docx, Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(512, 7)]));
  const png = path.join(tmp, "foto.png");
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
  // A finished report: no placeholder left to read a tag from, so /deanon must fall back to the
  // `output` a map recorded.
  const finished = path.join(tmp, "finale.md");
  fs.writeFileSync(finished, "Relazione finale consegnata.\n");
  fs.writeFileSync(
    path.join(home, "maps", "20260922-000002-cccccc.map.json"),
    JSON.stringify(
      {
        tag: "bb22cc",
        version: "1.6.0",
        schema: "anon/1",
        id: "20260922-000002-cccccc",
        source: "/fixture/verbale.md",
        output: finished,
        created: "2026-09-22T00:00:02+0200",
        counts: { PERSONA: 1 },
        entries: { "[PERSONA-1-bb22cc]": { type: "PERSONA", original: "Mario Rossi" } },
      },
      null,
      2,
    ),
  );
  return { home, sensitive, clean, big, docx, png, redacted, finished, maps: path.join(home, "maps") };
}

async function main() {
  const fx = writeFixtureHome();

  // --- healthy engine -------------------------------------------------------
  const g = await loadVariant("ok", pointToTemp);
  const readCall = (p) => g.handlers.tool_call[0]({ toolName: "read", input: { path: p } }, g.ctx);
  const toolResult = (tool, content) =>
    g.handlers.tool_result[0]({ toolName: tool, input: { command: "x", path: "d.docx" }, content: [{ type: "text", text: content }], isError: false }, g.ctx);

  const blocked = await readCall(fx.sensitive);
  check("read: sensitive file is BLOCKED", !!blocked && blocked.block === true);
  check(
    "read: the block reason never echoes the values",
    !!blocked && !/acme\.it|Mario Rossi|10\.42\.7\.19/.test(blocked.reason),
  );
  check("read: clean file is allowed", (await readCall(fx.clean)) === undefined);
  check("read: >8MB fails CLOSED", (await readCall(fx.big))?.block === true);
  check("read: maps dir is hard-BLOCKED", (await readCall(path.join(fx.maps, "dummy.map.json")))?.block === true);

  const binDoc = await readCall(fx.docx);
  check("read: binary document (.docx) is BLOCKED (fail-closed)", !!binDoc && binDoc.block === true);
  check("read: the binary message names doc_to_markdown", !!binDoc && /doc_to_markdown/.test(binDoc.reason));
  check("read: image is allowed (declared gap — pixels are not scannable)", (await readCall(fx.png)) === undefined);
  // The block message tells the caller to convert with doc_to_markdown: that call must not be
  // blocked too, or the remediation would be a dead end.
  const convCall = await g.handlers.tool_call[0]({ toolName: "doc_to_markdown", input: { path: fx.docx } }, g.ctx);
  check("doc_to_markdown: the .docx source is NOT blocked (remediation works)", convCall === undefined);

  const link = path.join(tmp, "map-link.json");
  fs.symlinkSync(path.join(fx.maps, "dummy.map.json"), link);
  check("read: symlink into maps is BLOCKED", (await readCall(link))?.block === true);

  const conv = await toolResult("doc_to_markdown", "Referente: Mario Rossi <mario.rossi@acme.it>\n");
  check("doc_to_markdown: sensitive Markdown is BLOCKED", conv?.isError === true);
  check("doc_to_markdown: hint names `output`", !!conv && conv.content[0].text.includes('output="'));
  check("doc_to_markdown: clean Markdown passes", (await toolResult("doc_to_markdown", "user@example.com\n")) === undefined);
  check("/anon command is registered", !!g.commands.anon);

  // --- /deanon: restores into a FILE, never into the editor (values must not enter the context) --
  check("/deanon command is registered", !!g.commands.deanon);
  await g.commands.deanon.handler(fx.redacted, g.ctx);
  const restored = path.join(tmp, "verbale.redacted.deanon.md");
  check("/deanon writes the restored document to a file", fs.existsSync(restored));
  check(
    "/deanon finds the map from the tag inside the document (no map argument)",
    fs.existsSync(restored) && fs.readFileSync(restored, "utf8").includes("mario.rossi@acme.it"),
  );
  const deanonMessages = g.messages.join("|");
  check("/deanon never pastes the real values into the editor", g.pasted.length === 0);
  check(
    "/deanon does not put real values in the notification",
    !deanonMessages.includes("acme.it") && !deanonMessages.includes("Mario Rossi"),
  );
  check("/deanon names the file it wrote", deanonMessages.includes("verbale.redacted.deanon.md"));

  // an explicit map id must work too
  g.messages.length = 0;
  await g.commands.deanon.handler(`${fx.redacted} 20260922-000000-aaaaaa`, g.ctx);
  check("/deanon accepts a map id", g.messages.join("|").includes("20260922-000000-aaaaaa.map.json"));

  // no candidate: refuse to guess
  g.messages.length = 0;
  await g.commands.deanon.handler(fx.clean, g.ctx);
  check("/deanon refuses to guess a map it cannot identify", /no map matches/.test(g.messages.join("|")));

  // a document with no readable placeholder: the map is found from the recorded `output`
  g.messages.length = 0;
  await g.commands.deanon.handler(fx.finished, g.ctx);
  check(
    "/deanon falls back to the recorded output when the document has no placeholder",
    fs.existsSync(path.join(tmp, "finale.deanon.md")),
  );

  // a document mixing two runs must not be restored with one map
  const mixed = path.join(tmp, "mixed.md");
  fs.writeFileSync(mixed, "A [CLIENTE-1-a3f9d1] e [CLIENTE-2-bb22cc]\n");
  g.messages.length = 0;
  await g.commands.deanon.handler(mixed, g.ctx);
  check("/deanon refuses a document that mixes two tags", /different tags/.test(g.messages.join("|")));

  // ambiguous: two maps claiming the same output
  fs.copyFileSync(
    path.join(fx.home, "maps", "20260922-000000-aaaaaa.map.json"),
    path.join(fx.home, "maps", "20260922-000001-bbbbbb.map.json"),
  );
  g.messages.length = 0;
  await g.commands.deanon.handler(fx.redacted, g.ctx);
  check("/deanon refuses to guess between two maps", /claim this file/.test(g.messages.join("|")));
  fs.rmSync(path.join(fx.home, "maps", "20260922-000001-bbbbbb.map.json"));

  check("default mode: bash output NOT rewritten (declared gap)", (await toolResult("bash", "mario.rossi@acme.it\n")) === undefined);
  g.flags["anon-guard"] = "all";
  check("--anon-guard=all: bash output IS blocked", (await toolResult("bash", "mario.rossi@acme.it\n"))?.isError === true);
  g.flags["anon-guard"] = "off";
  check("--anon-guard=off: sensitive read is allowed", (await readCall(fx.sensitive)) === undefined);

  // --- session-only allowlist (fresh paths: the verdict cache is keyed by path+mtime) ---------
  const freshAllowed = path.join(tmp, "fresh-allowed.txt");
  fs.writeFileSync(freshAllowed, "Cliente Acme, referente Mario Rossi <mario.rossi@acme.it>\n");
  g.flags["anon-guard"] = "on";
  g.flags["anon-guard-allow"] = `${tmp}/*`;
  check("--anon-guard-allow: a sensitive file under the glob is ALLOWED", (await readCall(freshAllowed)) === undefined);
  // A glob starting with '-' must not become an argparse error that the guard misreads as a broken
  // engine (that would fail OPEN and disable the guard for the whole session).
  const freshDash = path.join(tmp, "fresh-dash.txt");
  fs.writeFileSync(freshDash, "Cliente Acme, referente Mario Rossi <mario.rossi@acme.it>\n");
  g.flags["anon-guard-allow"] = "-badglob";
  const dashBlocked = await readCall(freshDash);
  check("a leading-dash glob does not disarm the guard", !!dashBlocked && dashBlocked.block === true);
  g.flags["anon-guard-allow"] = "";
  check("/anon-allow command is registered", !!g.commands["anon-allow"]);

  // --- auto-remediation of binary documents (DEC-0014) ---------------------
  const readCallIn = async (variant, p, { id, ...input } = {}) => {
    const event = { toolName: "read", toolCallId: id, input: { path: p, ...input } };
    const verdict = await variant.handlers.tool_call[0](event, variant.ctx);
    return { verdict, event };
  };
  const toolResultIn = (variant, { id, path: p, text }) =>
    variant.handlers.tool_result[0](
      { toolName: "read", toolCallId: id, input: { path: p }, content: [{ type: "text", text }], isError: false },
      variant.ctx,
    );
  const writeConverter = (body) => fs.writeFileSync(path.join(fx.home, "convert.py"), body);
  const GOOD_CONVERTER = "import sys\nsys.stdout.write('Cliente Acme, referente Mario Rossi <mario.rossi@acme.it>\\n')\n";
  const AUTO_DIR = path.join(fx.home, "auto");

  const a = await loadVariant("auto", pointToTemp);
  a.flags["anon-guard-auto"] = "on";
  // No converter in the fixture home yet: the failure path must BLOCK, never pass.
  const noConverter = await readCallIn(a, fx.docx);
  check("auto=on: a MISSING converter blocks (fail-closed)", noConverter.verdict?.block === true);

  writeConverter(GOOD_CONVERTER);
  const redirected = await readCallIn(a, fx.docx, { id: "tc-1", offset: 3, limit: 4 });
  const redirectedPath = String(redirected.event.input.path);
  check("auto=on: the binary read is NOT blocked", redirected.verdict === undefined, redirected.verdict?.reason);
  check(
    "auto=on: the path is rewritten to the redacted copy",
    /\.redacted\.md$/.test(redirectedPath) && redirectedPath !== fx.docx,
  );
  check(
    "auto=on: offset/limit are dropped (they referred to the original)",
    redirected.event.input.offset === undefined && redirected.event.input.limit === undefined,
  );
  check("auto=on: the copy lives under the private ANON_HOME", redirectedPath.startsWith(AUTO_DIR));
  const redactedText = fs.existsSync(redirectedPath) ? fs.readFileSync(redirectedPath, "utf8") : "";
  check(
    "auto=on: the copy holds placeholders and the email is gone",
    redactedText.includes("[") && !/acme\.it/.test(redactedText),
  );
  check("auto=on: the copy is mode 0600", (fs.statSync(redirectedPath).mode & 0o777) === 0o600);
  // The intermediate holds the REAL values: it must not stay on disk after the run.
  check(
    "auto=on: the un-redacted intermediate is removed",
    fs.readdirSync(AUTO_DIR).every((name) => name.endsWith(".redacted.md")),
  );
  check("auto=on: the operator is notified", a.toasts.length > 0);
  const banner = await toolResultIn(a, { id: "tc-1", path: redirectedPath, text: redactedText });
  check("auto=on: the model is told it is reading placeholders", !!banner && banner.content[0].text.includes("PLACEHOLDERS"));
  check("auto=on: the banner keeps the redacted content", !!banner && banner.content.length === 2);
  check("auto=on: the banner does NOT hand the model the map path", !!banner && !/maps/.test(banner.content[0].text));
  check("auto=on: no banner leaks into an unrelated read", (await toolResultIn(a, { id: "tc-2", path: fx.clean, text: "note" })) === undefined);

  // Every failure of the pipeline must BLOCK: a failed remediation is never "clean".
  writeConverter("import sys\nsys.exit(1)\n");
  const convFailed = await readCallIn(a, fx.docx, { id: "tc-3" });
  check(
    "auto=on: a converter that exits non-zero blocks",
    convFailed.verdict?.block === true && /did not complete/.test(String(convFailed.verdict.reason)),
  );
  writeConverter("import sys\nsys.stdout.write('')\n");
  check("auto=on: an EMPTY conversion blocks", (await readCallIn(a, fx.docx, { id: "tc-4" })).verdict?.block === true);
  writeConverter("import sys\nsys.stdout.write('x' * (13 * 1024 * 1024))\n");
  const capped = await readCallIn(a, fx.docx, { id: "tc-5" });
  check(
    "auto=on: output beyond the cap is cut off and blocks",
    capped.verdict?.block === true && /did not complete/.test(String(capped.verdict.reason)),
  );

  // ask: consent must be explicit, and a BROKEN dialog must not fail open (the check path fails
  // open on a broken engine; the remediation path must not inherit that policy).
  writeConverter(GOOD_CONVERTER);
  const ask = await loadVariant("ask", pointToTemp);
  check("auto=ask without a UI blocks (no invented consent)", (await readCallIn(ask, fx.docx)).verdict?.block === true);
  ask.ctx.hasUI = true;
  ask.ctx.ui.confirm = async () => false;
  check("auto=ask: answering no blocks", (await readCallIn(ask, fx.docx)).verdict?.block === true);
  ask.ctx.ui.confirm = async () => {
    throw new Error("dialog blew up");
  };
  check(
    "auto=ask: a REJECTING dialog still blocks (no fail-open)",
    (await readCallIn(ask, fx.docx)).verdict?.block === true,
  );
  ask.ctx.ui.confirm = async () => true;
  const askYes = await readCallIn(ask, fx.docx, { id: "tc-9" });
  check(
    "auto=ask: answering yes redirects to the redacted copy",
    askYes.verdict === undefined && /\.redacted\.md$/.test(String(askYes.event.input.path)),
  );

  const onlyBlock = await loadVariant("only-block", pointToTemp);
  onlyBlock.flags["anon-guard-auto"] = "off";
  const offRead = await readCallIn(onlyBlock, fx.docx);
  check(
    "auto=off: the binary is only blocked (DEC-0011 unchanged)",
    offRead.verdict?.block === true && /doc_to_markdown/.test(offRead.verdict.reason),
  );

  // --- broken engine --------------------------------------------------------
  fs.mkdirSync(path.join(tmp, "broken-home"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "broken-home", "shadow-version"), "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n");
  const b = await loadVariant("broken", (text) =>
    pointToTemp(text).replace(/const ANON_PY = [^;]+;/, `const ANON_PY = ${JSON.stringify(path.join(tmp, "broken-home", "shadow-version"))};`),
  );
  const brokenRead = await b.handlers.tool_call[0]({ toolName: "read", input: { path: fx.sensitive } }, b.ctx);
  check("broken engine: fails open (no block)", brokenRead === undefined);
  check("broken engine: persistent status indicator set", b.statuses.includes("OFF — engine unreachable"));
  check("broken engine: a warning toast is shown", b.toasts.length > 0);
}

main()
  .catch((err) => {
    failures++;
    if (!quiet) console.log(`FAIL  the check could not complete — ${(err && err.message) || err}`);
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`check-anon-guard: ${failures} check(s) failed — the guard does not enforce DEC-0014.`);
      process.exit(1);
    }
    if (!quiet) console.log("check-anon-guard: all runtime checks passed");
    process.exit(0);
  });
