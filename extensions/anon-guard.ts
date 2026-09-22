/**
 * anon-guard.ts — deterministic safety-net: no un-redacted sensitive content enters the context.
 *
 * The anonymizer (~/.anon/anon.py) is the product; this extension is the enforcement. It hooks
 * the two ways a document's content reaches the model and BLOCKS (not warns) when the
 * deterministic engine finds sensitive patterns that have not been replaced by placeholders:
 *
 *   - tool_call   `read`            -> check the file that is about to be read. A BINARY document
 *                                      (Word/PDF/Excel/archive) cannot be scanned, so with
 *                                      `--anon-guard-auto` the guard converts + anonymizes it in a
 *                                      subprocess and points the read at the redacted copy
 *                                      (`~/.anon/auto/*.redacted.md`); any failure blocks instead
 *                                      (DEC-0014). Never an LLM, never the network.
 *   - tool_result `doc_to_markdown` -> check the produced Markdown. The SOURCE is not checked at
 *                                      tool_call on purpose: converting a binary document IS the
 *                                      remediation, so blocking it would make the block message a
 *                                      dead end. What reaches the model is the converter OUTPUT.
 *   - tool_call   anything          -> hard-block reads of `~/.anon/maps/` (the maps hold the
 *                                      REAL values by design; they must never enter the context).
 *
 * The engine is a subprocess (`anon.py --check --json`), never a reimplementation: one source
 * of truth for what "sensitive" means. The report never echoes the matched values — only the
 * type and line — so a blocked read cannot leak the very data it protects.
 *
 * Failure policy: if the engine cannot run (python missing, crash), the guard FAILS OPEN with a
 * visible warning. A broken checker must not brick Pi; the privacy guarantee is best-effort,
 * not fail-closed.
 *
 * Configuration
 *   - `pi --anon-guard=off` (or PI_ANON_GUARD=0) disables the guard for the session.
 *   - `~/.anon/allow.txt` lists path globs the user declares un-sensitive (public repos,
 *     router configs, fixtures). The allowlist is evaluated by the engine, not here.
 *   - `pi --anon-guard-allow='/a/*,/b/*'` (or PI_ANON_GUARD_ALLOW) adds path globs for THIS
 *     session only, without editing allow.txt. `/anon-allow <path>` appends to the file instead.
 *   - `/anon <file>` runs the anonymizer and pastes the redacted text into the editor.
 *   - `/deanon <file> [map]` restores the real values into a FILE and reports where it wrote them.
 *     It deliberately does NOT paste them: they are exactly what must not enter the context.
 *   - `--anon-guard-auto=ask|on|off` (PI_ANON_GUARD_AUTO) decides whether a binary document is
 *     remediated automatically (default `ask`).
 *
 * Stopgap: if Pi ever grows native data-loss-prevention hooks, adopt them and discard this.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANON_HOME = path.join(os.homedir(), ".anon");
const ANON_PY = path.join(ANON_HOME, "anon.py");
const DEANON_PY = path.join(ANON_HOME, "deanon.py");
const MAPS_DIR = path.join(ANON_HOME, "maps");
const ALLOW_FILE = path.join(ANON_HOME, "allow.txt");
const CONVERTER = path.join(ANON_HOME, "convert.py");
// Private scratch for the auto-remediation: the intermediate Markdown holds the REAL values, so it
// never goes next to the source (a project directory can be a git repository).
const AUTO_DIR = path.join(ANON_HOME, "auto");
const CHECK_TIMEOUT_MS = 20_000;
// stderr is only used for diagnostics: past this it is dropped rather than accumulated.
const STDERR_CAP = 64 * 1024;
// Conversion spawns anydoc, which is slower than a text scan; the redaction that follows is the
// normal scan. Generous, because a timeout here falls back to blocking, not to failing open.
const AUTO_TIMEOUT_MS = 120_000;
// Sized against a MEASURED throughput, not an estimate. The engine scans ~1.8-2.0 MB/s with a
// 200-entry dictionary (scripts/bench-check.py in the anon-tool repo, measured 2026-09-22: 16 MB
// in 8.1s). Before the entity scan was rewritten it was 0.15 MB/s, which made the old 2 MB cap
// 13.7s — one dictionary entry more and every read would have timed out. 12 MB / 20s keeps a ~3x
// margin, and a timeout now BLOCKS the file instead of switching the guard off (see `timedOut`).
// Larger files stay fail-closed: never silently skipped.
const MAX_CHECK_BYTES = 12 * 1024 * 1024;
const CACHE_LIMIT = 512;

interface CheckResult {
	sensitive: boolean;
	total: number;
	types: Record<string, number>;
	findings: Array<{ type: string; line: number }>;
	allowed?: boolean;
	binary?: boolean;
	toolarge?: boolean;
	/** The engine did not answer within CHECK_TIMEOUT_MS: too slow to scan, not broken. */
	timeout?: boolean;
	/** Binary document (Word/PDF/Excel/archive): readable as text by Pi, but not scannable. */
	unscannable?: boolean;
}

interface CacheEntry {
	key: string;
	result: CheckResult;
}

const cache = new Map<string, CacheEntry>();
let engineWarned = false;
let engineFailed = false;

/** Guard scope: "off" | "read" (read + converters) | "all" (also bash/grep output). */
function guardMode(pi: ExtensionAPI): "off" | "read" | "all" {
	if (process.env.PI_ANON_GUARD === "0") return "off";
	const value = String(pi.getFlag("anon-guard") ?? "on").toLowerCase();
	if (["off", "false", "0", "no", "disable", "disabled"].includes(value)) return "off";
	return value === "all" ? "all" : "read";
}

/**
 * Session-only path globs, same fnmatch syntax as allow.txt, comma/newline separated. They are
 * handed to the engine as extra `--allow-glob` patterns, so the engine stays the single judge of
 * what "allowed" means — the guard never decides that itself.
 */
function sessionAllowGlobs(pi: ExtensionAPI): string[] {
	if (guardMode(pi) === "off") return [];
	const raw = `${pi.getFlag("anon-guard-allow") ?? ""},${process.env.PI_ANON_GUARD_ALLOW ?? ""}`;
	return raw
		.split(/[,\n]/)
		.map((glob) => glob.trim())
		.filter(Boolean);
}

/** Resolve symlinks: a lexical comparison let a symlink into ~/.anon/maps/ bypass the block. */
function realPath(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

const MAPS_REAL = realPath(MAPS_DIR);

function insideMapsDir(target: string): boolean {
	for (const candidate of [path.resolve(target), realPath(target)]) {
		const relative = path.relative(MAPS_REAL, candidate);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
	}
	return false;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	overCap: boolean;
}

function runScript(
	script: string,
	args: string[],
	timeoutMs: number,
	options: { stdin?: string; maxStdoutBytes?: number } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stdoutBytes = 0;
		const stdoutChunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let overCap = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Decode ONCE, from the whole byte stream: decoding each chunk on its own turned a
			// multibyte character straddling a pipe-buffer boundary into U+FFFD, silently corrupting
			// an accented document (and the entity it carried) before the engine ever scanned it.
			stdout = Buffer.concat(stdoutChunks).toString("utf8");
			resolve({ code, stdout, stderr, timedOut, overCap });
		};
		const child = spawn("python3", [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const stop = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		};
		timer = setTimeout(() => {
			timedOut = true;
			stop();
			finish(-1);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			// The cap is applied WHILE the child writes, not after buffering it all: a converter that
			// inflates a document must not be able to exhaust Pi's memory before the check runs.
			if (options.maxStdoutBytes !== undefined && stdoutBytes > options.maxStdoutBytes) {
				overCap = true;
				stop();
				finish(-1);
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length >= STDERR_CAP) return;
			stderr += String(chunk);
		});
		child.on("error", () => finish(-1));
		child.on("close", (code) => finish(code ?? -1));
		try {
			if (options.stdin !== undefined) child.stdin.write(options.stdin);
			child.stdin.end();
		} catch {
			/* EPIPE if the child died early; the close handler resolves */
		}
	});
}

function runAnon(args: string[], stdin?: string): Promise<RunResult> {
	return runScript(ANON_PY, args, CHECK_TIMEOUT_MS, { stdin });
}

interface GuardCtx {
	hasUI: boolean;
	ui: {
		notify: (m: string, t?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, text: string | undefined) => void;
		confirm?: (title: string, message: string) => Promise<boolean>;
	};
}

function warnEngineOnce(ctx: GuardCtx): void {
	// The status line is the persistent signal: a single transient toast is easy to miss, and
	// after this the guard is off for the rest of the session.
	ctx.ui.setStatus?.("anon-guard", "OFF — engine unreachable");
	if (engineWarned) return;
	engineWarned = true;
	ctx.ui.notify(
		`anon-guard: ${ANON_PY} did not answer (is python3 available?) — the guard is INACTIVE for this session.`,
		"warning",
	);
}

/**
 * The verdict depends on the allowlist as well as on the file. Editing ~/.anon/allow.txt is the
 * documented way to un-block a path, and without this fingerprint a "sensitive" verdict cached
 * before the edit would keep blocking that file for the rest of the session: the cache key was
 * path+mtime+size, none of which change when the allowlist does. `/anon-allow` clears the cache
 * because it goes through this extension; a hand edit does not, and that is the common case.
 */
function allowFingerprint(extraGlobs: string[]): string {
	try {
		const st = statSync(ALLOW_FILE);
		return `${st.mtimeMs}:${st.size}:${extraGlobs.join(",")}`;
	} catch {
		return `absent:${extraGlobs.join(",")}`;
	}
}

/** Check a file with the deterministic engine. Returns null when the engine is unavailable. */
async function checkFile(target: string, ctx: GuardCtx, extraGlobs: string[]): Promise<CheckResult | null> {
	let stat;
	try {
		stat = statSync(target);
	} catch {
		return null; // does not exist / not readable: let the tool report its own error
	}
	if (!stat.isFile()) return null;
	const key = `${stat.mtimeMs}:${stat.size}:${allowFingerprint(extraGlobs)}`;
	const hit = cache.get(target);
	if (hit && hit.key === key) return hit.result;
	// Fail CLOSED on "cannot check": silently skipping a 9 MB dump would leak exactly what
	// this guard exists to stop. The message tells the user how to proceed.
	if (stat.size > MAX_CHECK_BYTES) {
		return { sensitive: true, total: 1, types: {}, findings: [], toolarge: true };
	}
	if (engineFailed) return null;

	// The `--allow-glob=` equals form matters: a glob beginning with `-` would otherwise be rejected
	// by argparse, produce no JSON, and be misread as a broken engine (fail-open for the session).
	const allowArgs = extraGlobs.flatMap((glob) => [`--allow-glob=${glob}`]);
	const res = await runAnon([target, "--check", "--json", ...allowArgs]);
	// A timeout is NOT "the engine is broken". The file was too slow to scan, and the only safe
	// answer is to block it: treating it as an engine failure set `engineFailed` and turned the
	// guard OFF for the rest of the session — one big file and every later read passed unscanned.
	if (res.timedOut) {
		return { sensitive: true, total: 1, types: {}, findings: [], timeout: true };
	}
	return interpret(res, target, key, ctx);
}

/**
 * A VALID JSON report is the only success signal: `--check` legitimately exits 1 when it finds
 * sensitive content, so the exit code cannot be the test. Empty/garbage stdout (engine missing,
 * crashed, import error) means the guard is broken — warn and stop checking, rather than passing
 * every file as clean with no indicator at all.
 */
async function interpret(
	res: { code: number; stdout: string; stderr: string },
	target: string,
	key: string,
	ctx: GuardCtx,
): Promise<CheckResult | null> {
	if (res.code < 0) {
		warnEngineOnce(ctx);
		engineFailed = true; // do not pay the timeout on every subsequent read
		return null;
	}
	try {
		const parsed = JSON.parse(res.stdout) as CheckResult;
		if (cache.size >= CACHE_LIMIT) cache.clear();
		cache.set(target, { key, result: parsed });
		return parsed;
	} catch {
		warnEngineOnce(ctx);
		engineFailed = true;
		return null;
	}
}

/** Check arbitrary text (the Markdown a converter produced) through the engine's stdin mode. */
async function checkText(text: string, ctx: GuardCtx): Promise<CheckResult | null> {
	if (engineFailed) return null;
	const res = await runAnon(["-", "--check", "--json"], text);
	if (res.timedOut) {
		return { sensitive: true, total: 1, types: {}, findings: [], timeout: true };
	}
	return interpret(res, "<text>", "", ctx);
}

/** How the guard treats a binary document: ask (default), always remediate, or only block. */
function guardAutoMode(pi: ExtensionAPI): "ask" | "on" | "off" {
	const raw = String(pi.getFlag("anon-guard-auto") ?? process.env.PI_ANON_GUARD_AUTO ?? "ask")
		.trim()
		.toLowerCase();
	if (["off", "false", "0", "no", "disable", "disabled", "block"].includes(raw)) return "off";
	if (["on", "true", "1", "yes", "auto", "always"].includes(raw)) return "on";
	return "ask";
}

interface AutoRead {
	toolCallId?: string;
	redactedPath: string;
}

const AUTO_READS_LIMIT = 64;
const autoReads: AutoRead[] = [];

/** Consume the redirect record for a finished read (by tool call id, or by the rewritten path). */
function takeAutoRead(toolCallId: string | undefined, target: unknown): AutoRead | undefined {
	const targetPath = typeof target === "string" ? target : "";
	for (let i = 0; i < autoReads.length; i++) {
		const entry = autoReads[i];
		const byId = entry.toolCallId !== undefined && entry.toolCallId === toolCallId;
		const byPath = targetPath !== "" && entry.redactedPath === targetPath;
		if (byId || byPath) return autoReads.splice(i, 1)[0];
	}
	return undefined;
}

interface AutoOutcome {
	redactedPath: string;
	map: string | null;
	entries: number;
	counts: string;
}

/**
 * convert -> anonymize, entirely local. Returns null on ANY failure: the caller then blocks, so a
 * failed remediation never becomes "clean" (DEC-0014).
 */
async function autoPipeline(source: string): Promise<AutoOutcome | null> {
	const converted = await runScript(CONVERTER, [source], AUTO_TIMEOUT_MS, {
		maxStdoutBytes: MAX_CHECK_BYTES,
	});
	if (converted.code !== 0 || converted.overCap || !converted.stdout.trim()) return null;
	// The intermediate Markdown holds the REAL values: private dir, mode 0600.
	const key = `${createHash("sha1").update(source).digest("hex").slice(0, 8)}-${path.basename(source)}`;
	const markdown = path.join(AUTO_DIR, `${key}.md`);
	try {
		mkdirSync(AUTO_DIR, { recursive: true, mode: 0o700 });
		writeFileSync(markdown, converted.stdout, { mode: 0o600 });
	} catch {
		return null;
	}
	const anon = await runScript(ANON_PY, [markdown, "--json"], AUTO_TIMEOUT_MS);
	// Drop the intermediate whatever the outcome: it holds the REAL values, the redacted copy and
	// the map are what the operator needs, and a failed run already tells them how to convert by
	// hand. Keeping it would leave real data accumulating in ~/.anon/auto/ with nothing to prune it.
	try {
		unlinkSync(markdown);
	} catch {
		/* best effort: the redacted copy is what matters */
	}
	if (anon.code !== 0) return null;
	let summary: { redacted?: unknown; map?: unknown; entries?: unknown; counts?: unknown };
	try {
		summary = JSON.parse(anon.stdout) as typeof summary;
	} catch {
		return null;
	}
	const redactedPath = typeof summary.redacted === "string" ? summary.redacted : "";
	if (!redactedPath || !existsSync(redactedPath)) return null;
	const counts = Object.entries((summary.counts as Record<string, number>) ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([type, count]) => `${type}x${count}`)
		.join(", ");
	return {
		redactedPath,
		map: typeof summary.map === "string" ? summary.map : null,
		entries: Number(summary.entries ?? 0),
		counts,
	};
}

function autoFailedMessage(source: string): string {
	return [
		`anon-guard: BLOCKED — automatic conversion of ${source} did not complete.`,
		"A failed remediation falls back to the fail-closed block, never to \"clean\". Convert it by hand:",
		`  1. doc_to_markdown(path="${source}", output="${source}.md")`,
		`  2. /anon "${source}.md"`,
		"  3. read the redacted Markdown it produces.",
	].join("\n");
}

/**
 * `read` of a binary document: remediate, or block (DEC-0014). Returns a block verdict when
 * remediation is not applicable or fails, `undefined` after a successful redirect.
 *
 * This wrapper must never throw: the tool_call handler's outer catch exists for the CHECK path
 * (fail-open on a broken engine, DEC-0011). Letting it swallow a broken REMEDIATION would return
 * undefined and let the read proceed on the original binary — un-redacted, which is the exact leak
 * the guard exists to stop. Found by an adversarial review, not by the harness (which was green).
 */
async function tryAutoRemediate(
	source: string,
	event: { input: { path: string; offset?: number; limit?: number }; toolCallId?: string },
	ctx: GuardCtx,
	pi: ExtensionAPI,
): Promise<{ block: true; reason: string } | undefined> {
	try {
		return await autoRemediate(source, event, ctx, pi);
	} catch {
		return { block: true, reason: autoFailedMessage(source) };
	}
}

async function autoRemediate(
	source: string,
	event: { input: { path: string; offset?: number; limit?: number }; toolCallId?: string },
	ctx: GuardCtx,
	pi: ExtensionAPI,
): Promise<{ block: true; reason: string } | undefined> {
	const mode = guardAutoMode(pi);
	if (mode === "off" || !existsSync(CONVERTER)) {
		return { block: true, reason: unscannableMessage(source) };
	}
	let proceed = mode === "on";
	if (!proceed) {
		if (!ctx.hasUI || !ctx.ui.confirm) {
			// `ask` without a UI is not consent. Never invent one: say how to choose explicitly.
			return {
				block: true,
				reason:
					unscannableMessage(source) +
					"\n(auto-detection needs a confirmation and there is no UI: use --anon-guard-auto=on to\n" +
					"convert+anonymize automatically, or --anon-guard-auto=off to always block.)",
			};
		}
		proceed = await ctx.ui.confirm(
			"anon-guard — documento binario",
			`${path.basename(source)} non è scansionabile.\n\n` +
				"Lo converto in Markdown e lo anonimizzo, poi leggi la copia con i placeholder?\n" +
				"L'originale non viene toccato; la mappa resta in ~/.anon/maps/.",
		);
	}
	if (!proceed) return { block: true, reason: unscannableMessage(source) };

	const outcome = await autoPipeline(source);
	if (!outcome) return { block: true, reason: autoFailedMessage(source) };

	event.input.path = outcome.redactedPath;
	// offset/limit are coordinates in the ORIGINAL document: keeping them would silently read the
	// wrong slice of a different file.
	delete event.input.offset;
	delete event.input.limit;
	autoReads.push({ toolCallId: event.toolCallId, redactedPath: outcome.redactedPath });
	if (autoReads.length > AUTO_READS_LIMIT) autoReads.shift();
	ctx.ui.notify(
		`anon-guard: ${path.basename(source)} → copia redatta\n${outcome.redactedPath}\n` +
			`${outcome.entries} placeholder(s)${outcome.counts ? ` [${outcome.counts}]` : ""}` +
			(outcome.map ? `\nmappa: ${outcome.map}` : ""),
		"info",
	);
	return undefined;
}

interface MapFile {
	file: string;
	id: string;
	created: string;
	source: string;
	tag: string;
	output: string;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Every readable map in ~/.anon/maps. An unreadable one is skipped, not invented. */
function readMaps(): MapFile[] {
	const found: MapFile[] = [];
	let names: string[];
	try {
		names = readdirSync(MAPS_DIR);
	} catch {
		return found;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".map.json")) continue;
		const file = path.join(MAPS_DIR, name);
		try {
			const payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			found.push({
				file,
				id: asString(payload.id),
				created: asString(payload.created),
				source: asString(payload.source),
				tag: asString(payload.tag),
				output: asString(payload.output),
			});
		} catch {
			/* not a map we can offer; the UI reports unreadable maps on its own */
		}
	}
	return found;
}

const TAG_IN_DOCUMENT_RE = /\[[A-Z][A-Z0-9_]*-\d+-([0-9a-f]{4,8})\]/g;

/**
 * The tags the document itself carries. This is the primary way `/deanon` finds its map: the
 * documented workflow restores the FINISHED document, whose name has nothing to do with the
 * redacted source, so matching on a recorded path would miss. Reads at most MAX_CHECK_BYTES and
 * never sends the bytes anywhere; a container's placeholders live in compressed XML and are simply
 * not found, which falls back to the recorded `output`.
 */
function tagsInDocument(target: string): string[] {
	try {
		const stat = statSync(target);
		if (!stat.isFile() || stat.size > MAX_CHECK_BYTES) return [];
		const text = readFileSync(target, "latin1"); // byte-preserving: this is a search, not a decode
		return [...new Set([...text.matchAll(TAG_IN_DOCUMENT_RE)].map((match) => match[1]))];
	} catch {
		return [];
	}
}

/**
 * The maps that could have produced `target`, matched on the `output` anon.py recorded. Used as a
 * fallback when the document carries no readable placeholder (a .docx, or a report with the
 * placeholders already restored once).
 */
function mapsProducing(target: string): MapFile[] {
	const base = path.basename(target);
	return readMaps().filter(
		(m) => m.output !== "" && (path.resolve(m.output) === target || path.basename(m.output) === base),
	);
}

function unscannableMessage(target: string): string {
	return [
		`anon-guard: BLOCKED — ${target} is a binary document (Word/PDF/Excel/archive).`,
		"It cannot be scanned for sensitive data, and Pi's read tool decodes non-image files as text —",
		"so reading it directly would hand its content to the model. Convert it first:",
		`  1. doc_to_markdown(path="${target}", output="${target}.md")`,
		`  2. /anon "${target}.md"`,
		"  3. read the redacted Markdown it produces.",
	].join("\n");
}

function tooLargeMessage(target: string): string {
	return [
		`anon-guard: BLOCKED — ${target} is larger than ${Math.round(MAX_CHECK_BYTES / 1024 / 1024)} MB, too large to check.`,
		"The engine scans about 2 MB/s (measured, scripts/bench-check.py), so a bigger file would not",
		"finish inside the guard's timeout. The guard fails closed on what it cannot scan:",
		"  · anonymize the file with the CLI first and read the redacted part, or work on an extract;",
		"  · declare the path in ~/.anon/allow.txt if it is legitimately public;",
		"  · or start Pi with --anon-guard=off for this session.",
	].join("\n");
}

function timeoutMessage(target: string): string {
	return [
		`anon-guard: BLOCKED — checking ${target} took longer than ${Math.round(CHECK_TIMEOUT_MS / 1000)}s.`,
		"The guard does not know whether the file is sensitive, so it blocks rather than guess — and it",
		"stays ACTIVE: this is the file being too slow, not the engine being unavailable.",
		"  · anonymize a smaller extract, or run the engine on it directly and read the redacted part;",
		"  · declare the path in ~/.anon/allow.txt if it is legitimately public;",
		"  · or start Pi with --anon-guard=off for this session.",
	].join("\n");
}

function summarize(result: CheckResult): string {
	const types = Object.entries(result.types)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([type, count]) => `${type}x${count}`)
		.join(", ");
	const lines = result.findings
		.slice(0, 5)
		.map((f) => `${f.type}@${f.line}`)
		.join(" ");
	return lines ? `${types} (${lines})` : types;
}

function blockMessage(target: string, result: CheckResult, kind: "read" | "converted" = "read"): string {
	const howTo =
		kind === "converted"
			? [
				"This extension keeps un-redacted personal data out of the model context. Do not work around it:",
				"  1. Write the Markdown to a file instead of returning it:",
				`     doc_to_markdown(path="${target}", output="${target}.md")`,
				`  2. Anonymize that file:    /anon ${target}.md`,
				"  3. Read the redacted copy (the *.redacted.* path it produces).",
			]
			: [
				"This extension keeps un-redacted personal data out of the model context. Do not work around it:",
				`  1. Anonymize the file:      /anon ${target}`,
				"  2. Work on the redacted copy (read the *.redacted.* path it produces).",
			];
	return [
		`anon-guard: BLOCKED — ${target} contains sensitive data that is not anonymized: ${summarize(result)}.`,
		...howTo,
		"  · If the file is legitimately public, add a glob to ~/.anon/allow.txt.",
		"  · To disable the guard for a session: pi --anon-guard=off",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("anon-guard", {
		type: "string",
		default: "on",
		description:
			"Block un-anonymized sensitive data (default: on = read/doc_to_markdown; 'all' also checks bash/grep output; 'off' disables).",
	});

	pi.registerFlag("anon-guard-allow", {
		type: "string",
		default: "",
		description:
			"Comma-separated path globs treated as un-sensitive for THIS session only (same syntax as ~/.anon/allow.txt).",
	});

	pi.registerFlag("anon-guard-auto", {
		type: "string",
		default: "ask",
		description:
			"On read of a binary document: 'ask' (default) convert+anonymize after a confirmation, 'on' without asking, 'off' to only block. Local, no LLM, no network.",
	});

	pi.on("tool_call", async (event, ctx) => {
		if (guardMode(pi) === "off") return;

		// The maps hard-block applies to ANY tool carrying a path — it must not be lost just
		// because the tool is not `read` (a converter can read a file too).
		const pathInput = (event.input as { path?: unknown }).path;
		const resolved = typeof pathInput === "string" ? path.resolve(ctx.cwd, pathInput) : undefined;
		if (resolved && insideMapsDir(resolved)) {
			return {
				block: true,
				reason:
					`anon-guard: BLOCKED — ${resolved} is inside ~/.anon/maps/.\n` +
					"Those maps hold the REAL values behind the placeholders; they must never enter the " +
					"context. Read the redacted document instead, and re-apply the map only at the end " +
					"with `deanon.py` (outside the agent).",
			};
		}

		// Only `read` is checked at the source. `doc_to_markdown` is deliberately NOT blocked here:
		// converting a binary document to Markdown IS the remediation (blocking it would make the
		// block message a dead end), and a converter's own output is checked in `tool_result`
		// below — which is the content that actually reaches the model.
		if (!isToolCallEventType("read", event)) return;
		if (!resolved) return;

		try {
			const globs = sessionAllowGlobs(pi);
			const result = await checkFile(resolved, ctx, globs);
			if (result?.toolarge) {
				return { block: true, reason: tooLargeMessage(resolved) };
			}
			if (result?.timeout) {
				return { block: true, reason: timeoutMessage(resolved) };
			}
			if (result?.unscannable) {
				// DEC-0014: try to convert + anonymize and redirect the read. A failure returns a block
				// verdict; if it returns undefined the target was rewritten, so fall through to nothing.
				const verdict = await tryAutoRemediate(resolved, event, ctx, pi);
				if (verdict) return verdict;
				return;
			}
			if (result?.sensitive) {
				return { block: true, reason: blockMessage(resolved, result) };
			}
		} catch {
			/* never break a tool call because of the guard */
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const mode = guardMode(pi);
		if (mode === "off") return;
		// A read the guard redirected to the redacted copy (DEC-0014): tell the model what it holds,
		// so it does not try to reconstruct the values or treat placeholders as data. Deliberately no
		// map path here — inviting the model to read ~/.anon/maps/ would be inviting a block.
		const redirect = takeAutoRead(event.toolCallId, (event.input as { path?: unknown }).path);
		if (redirect) {
			const banner =
				"[anon-guard] This binary document was converted and anonymized on the fly: what follows " +
				"are PLACEHOLDERS, not the real values. Do not try to guess or reconstruct them; the real " +
				"values stay outside this context and are re-applied by the operator at the end.";
			return { content: [{ type: "text" as const, text: `${banner}\n\n` }, ...event.content] };
		}
		// doc_to_markdown: the source of a .docx/.pdf is binary, so the content-level check must
		// happen on the produced Markdown. bash/grep output is checked only in "all" mode — in
		// normal work shell output is full of emails/IPs that are not secrets, so blocking it by
		// default would make Pi unusable. The gap is documented rather than hidden.
		const isConverter = event.toolName === "doc_to_markdown";
		const isShell = mode === "all" && (event.toolName === "bash" || event.toolName === "grep");
		if (!isConverter && !isShell) return;
		// A path the operator declared un-sensitive (allow.txt, --anon-guard-allow, --allow-glob) makes
		// the Markdown produced FROM it un-sensitive too: otherwise allowlisting a folder would still
		// block every .docx converted from that folder, and the block message would point at allow.txt
		// the user had already set.
		if (isConverter) {
			const source = (event.input as { path?: unknown }).path;
			if (typeof source === "string") {
				try {
					const sourceResult = await checkFile(path.resolve(ctx.cwd, source), ctx, sessionAllowGlobs(pi));
					if (sourceResult?.allowed) return;
				} catch {
					/* never break a tool result because of the guard */
				}
			}
		}
		const text = event.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
		if (!text.trim()) return;
		try {
			const result = await checkText(text, ctx);
			if (result?.sensitive) {
				const input = event.input as { path?: unknown };
				const source = typeof input.path === "string" ? input.path : `${event.toolName} output`;
				const message = result.timeout
					? timeoutMessage(String(source))
					: isConverter
					? blockMessage(String(source), result, "converted")
					: `anon-guard: BLOCKED — the output of \`${event.toolName}\` contains sensitive data: ` +
						`${summarize(result)}.\nThe values were withheld from the context. Anonymize the source ` +
						"first (anon → work → deanon), or run Pi with --anon-guard=read to limit the guard to " +
						"read/doc_to_markdown.";
				return { content: [{ type: "text" as const, text: message }], isError: true };
			}
		} catch {
			/* never break a tool result because of the guard */
		}
	});

	pi.registerCommand("anon", {
		description: "Anonymize a file and paste the redacted text into the editor (/anon <file>)",
		handler: async (args, ctx) => {
			const target = (args || "").trim();
			if (!target) {
				ctx.ui.notify("usage: /anon <file>", "info");
				return;
			}
			const resolved = path.resolve(ctx.cwd, target);
			if (!existsSync(resolved)) {
				ctx.ui.notify(`anon: file not found: ${resolved}`, "error");
				return;
			}
			const res = await runAnon([resolved, "--json"]);
			if (res.code !== 0) {
				ctx.ui.notify(`anon: engine failed (${res.stderr.trim() || `exit ${res.code}`})`, "error");
				return;
			}
			let summary: { sensitive: boolean; redacted: string; map: string | null; entries: number; counts: Record<string, number> };
			try {
				summary = JSON.parse(res.stdout);
			} catch {
				ctx.ui.notify("anon: unparseable engine output", "error");
				return;
			}

			if (!summary.sensitive) {
				ctx.ui.notify(`anon: nothing sensitive found in ${path.basename(resolved)}`, "info");
			}
			const counts = Object.entries(summary.counts ?? {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([type, n]) => `${type}x${n}`)
				.join(", ");
			ctx.ui.notify(
				`anon: ${summary.entries} placeholder(s)${counts ? ` [${counts}]` : ""}` +
					(summary.map ? `\nmap: ${summary.map}` : ""),
				"info",
			);

			try {
				const { readFileSync } = await import("node:fs");
				ctx.ui.pasteToEditor(readFileSync(summary.redacted, "utf8"));
			} catch {
				ctx.ui.setEditorText(`(redacted copy: ${summary.redacted})`);
			}
		},
	});

	pi.registerCommand("deanon", {
		description:
			"Restore the real values into a FILE — never into the editor (/deanon <file> [<map-path|map-id>])",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			if (!parts.length) {
				ctx.ui.notify("usage: /deanon <file> [<map-path|map-id>]", "info");
				return;
			}
			if (!existsSync(DEANON_PY)) {
				ctx.ui.notify(`deanon: engine not found at ${DEANON_PY}`, "error");
				return;
			}
			const target = path.resolve(ctx.cwd, parts[0]);
			if (!existsSync(target)) {
				ctx.ui.notify(`deanon: file not found: ${target}`, "error");
				return;
			}
			// Which map? Explicit wins; otherwise the one whose recorded OUTPUT is this file. Never a
			// guess: restoring with the wrong map is the case the per-map tag exists to prevent.
			let mapFile: string;
			if (parts[1]) {
				const literal = path.resolve(ctx.cwd, parts[1]);
				const byId = path.join(MAPS_DIR, `${parts[1].replace(/\.map\.json$/, "")}.map.json`);
				if (existsSync(literal)) mapFile = literal;
				else if (existsSync(byId)) mapFile = byId;
				else {
					ctx.ui.notify(`deanon: map not found: ${parts[1]}`, "error");
					return;
				}
			} else {
				// Primary signal: the tags the document carries (the finished document's name tells us
				// nothing). Fallback: the `output` a map recorded. Never a guess: with 0 or 2+ candidates
				// the command asks instead of picking, because restoring with the WRONG map is the
				// failure the per-map tag exists to prevent.
				const tags = tagsInDocument(target);
				const maps = readMaps();
				if (tags.length > 1) {
					ctx.ui.notify(
						`deanon: this document carries ${tags.length} different tags — it mixes runs.\n` +
							"Restore the parts with their own maps, or pass the map explicitly.",
						"warning",
					);
					return;
				}
				let candidates = tags.length ? maps.filter((map) => map.tag === tags[0]) : [];
				if (!candidates.length) candidates = mapsProducing(target);
				if (candidates.length === 0) {
					ctx.ui.notify(
						`deanon: no map matches ${path.basename(target)} (no readable placeholder tag, and no\n` +
							"map records it as its output). Pass the map explicitly: /deanon <file> <map-id>.",
						"warning",
					);
					return;
				}
				if (candidates.length > 1) {
					const list = candidates
						.slice(0, 5)
						.map((candidate) => `  ${candidate.id} (${candidate.created || "?"})`)
						.join("\n");
					ctx.ui.notify(
						`deanon: ${candidates.length} maps claim this file — say which one you used:\n${list}`,
						"warning",
					);
					return;
				}
				mapFile = candidates[0].file;
			}

			const res = await runScript(DEANON_PY, [target, mapFile, "--json"], AUTO_TIMEOUT_MS);
			let report: Record<string, unknown>;
			try {
				report = JSON.parse(res.stdout) as Record<string, unknown>;
			} catch {
				ctx.ui.notify(
					`deanon: unparseable engine output (${res.stderr.trim() || `exit ${res.code}`})`,
					"error",
				);
				return;
			}
			const output = asString(report.output);
			const summary =
				`deanon: ${Number(report.replaced ?? 0)} value(s) restored\n` +
				(output ? `${output}\n` : "") +
				`map ${path.basename(mapFile)}` +
				(report.map_created ? ` of ${asString(report.map_created)}` : "") +
				(report.map_source ? ` from ${path.basename(asString(report.map_source))}` : "");
			// Deliberately NOT `pasteToEditor`: the real values are the thing this guard exists to keep
			// out of the model context. The command writes a file and reports where it is.
			if (report.complete === true) {
				ctx.ui.notify(
					`${summary}\n\nThe real values are in that FILE only — never pasted here, so they stay out of the context.`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`${summary}\n\nINCOMPLETE — do not deliver it: ${Number(report.remaining ?? 0)} placeholder(s) ` +
						`and ${Number(report.unknown_placeholders ?? 0)} unknown token(s) left (stderr has the reason).`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("anon-allow", {
		description:
			"Treat a path as un-sensitive for the guard: append a glob to ~/.anon/allow.txt (/anon-allow <path>)",
		handler: async (args, ctx) => {
			const target = (args || "").trim();
			if (!target) {
				ctx.ui.notify("usage: /anon-allow <path-or-glob>  (a directory becomes /path/*)", "info");
				return;
			}
			// A newline would inject extra allowlist lines and defeat the duplicate check below.
			if (/[\r\n]/.test(target)) {
				ctx.ui.notify("anon-allow: a path or glob cannot contain a newline", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("anon-allow: needs an interactive confirmation — add the glob to ~/.anon/allow.txt manually", "warning");
				return;
			}
			const resolved = path.resolve(ctx.cwd, target);
			let glob = resolved;
			try {
				if (statSync(resolved).isDirectory()) glob = `${resolved}/*`;
			} catch {
				// Not an existing path: only accept it as a literal glob, never silently.
				if (!target.includes("*")) {
					ctx.ui.notify(`anon-allow: not found: ${resolved}`, "error");
					return;
				}
				glob = target;
			}
			const current = existsSync(ALLOW_FILE) ? readFileSync(ALLOW_FILE, "utf8") : "";
			// Normalize CRLF: load_allowlist strips `\r`, so the caller's file may be CRLF while the
			// engine still honours it — the duplicate check must match that, or entries accumulate.
			const existing = current.split(/\r?\n/).map((line) => line.trim());
			if (existing.includes(glob)) {
				ctx.ui.notify(`anon-allow: already in ~/.anon/allow.txt:\n${glob}`, "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"anon-allow",
				`Treat this as un-sensitive from now on?\n${glob}\n\nAppended to ~/.anon/allow.txt — the guard will no longer check it.`,
			);
			if (!ok) {
				ctx.ui.notify("anon-allow: not added", "info");
				return;
			}
			appendFileSync(ALLOW_FILE, `${current === "" || current.endsWith("\n") ? "" : "\n"}${glob}\n`);
			// The verdict cache is keyed by path+mtime; without this, a file already scanned this
			// session would keep returning the stale "sensitive" verdict after being allowlisted.
			cache.clear();
			ctx.ui.notify(`anon-allow: added to ~/.anon/allow.txt:\n${glob}`, "info");
		},
	});
}
