/**
 * session-memory — durable plaintext memory of what was done, for long/interrupted sessions.
 *
 * Writes Markdown (plaintext) under <cwd>/.pi/memory/ — deliberately NOT versioned. A
 * self-gitignore (memoryDir/.gitignore containing `*`) stops the files leaking into a tracked
 * `.pi/`. The mechanism itself IS versioned (this file).
 *
 * Pieces:
 *   1. session_compact  -> append the compaction summary to <project>-<YYYY-MM-DD>.md
 *      (reuses pi's already-paid summary: zero extra LLM cost, fires only on long sessions).
 *   2. /note <text>     -> append a dated line to LOG.md (accumulating, human-readable log).
 *   3. handoff.ts       -> additionally saves the /handoff resume prompt to handoff-<ts>.md.
 *
 * Extensions (IDEA distillata da @fradser/pi-memory, MIT — "idea sì, plugin no"):
 *   4. /note-safe <text> -> append to <cwd>/.memory/SAFE.md — the explicitly-safe, GIT-TRACKED
 *      mirror. Private memory stays in .pi/memory/; only content the user marks safe is ever
 *      committed. (split privato/pubblico, AGENTS.md §6.)
 *   5. /consolidate      -> parent-owned consolidation: a read-only worker (read/ls/find/grep,
 *      no bash, no write) distills the accumulated .pi/memory/*.md into one deduplicated
 *      document; the PARENT validates and applies it with an atomic write + receipt. The
 *      worker never writes memory itself — it only proposes. (trust boundary.)
 *
 * (IDEA distillata da pi-hermes-memory / Hermes Agent, MIT — "idea sì, plugin no"):
 *   6. /memory <query>   -> FTS5 search over durable memory (global ~/.pi/agent/memory/ +
 *      project .pi/memory/), reusing rag.py with an explicit --db (one indexer, no new dep).
 *   7. secret scanning   -> deterministic regex guard: write/edit targeting a memory dir
 *      (and /note, /note-safe) is blocked when the content looks like a credential. The
 *      model is never the judge; the guard covers the write/edit paths the memory skill
 *      instructs (a bash `cat >>` bypasses it and is therefore discouraged).
 *   8. memory_search / memory_consolidate TOOLS -> the agent can search and consolidate
 *      durable memory itself, not only via the human-facing /memory, /consolidate commands.
 *
 * Structured memory (heavy tier — decisions/invariants/constraints, see the memory skill):
 *   9. decision guard   -> append-only enforcement: edit/write-overwrite of a validated
 *      .pi/decisions/*.md decision is blocked (supersede with a new DEC-*.md instead).
 *   10. verify_decisions TOOL -> evidence-based verification of validated decisions against
 *      L0 via verify.py (auto/read/human); trail in verification.json (gitignored sidecar).
 *   11. resume state    -> session_compact also writes .pi/memory/state.md (L2 resume point);
 *      at agent start the model is pointed at it (resume from state, not conversation).
 *   12. re-verify       -> on compaction, re-verify (evidence-based, via verify.py) the decisions
 *      cited in the compacted span, so the verification trail stays fresh where the work happened.
 */

import { mkdir, writeFile, appendFile, access, readdir, rename, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_MEMORY_FILES = 50;      // cap sui file passati al worker (input bounded)
const MAX_OUTPUT_BYTES = 50_000;  // cap sull'output consolidato (write bounded)

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function nowParts(d = new Date()): { date: string; time: string } {
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
	};
}

function memoryDir(cwd: string): string {
	return path.join(cwd, ".pi", "memory");
}

function safeMemoryDir(cwd: string): string {
	return path.join(cwd, ".memory");
}

function projectKey(cwd: string): string {
	return (path.basename(cwd) || "project").replace(/[^\w.-]+/g, "_");
}

function memoryGlobalDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "memory");
}

/** Structured decision/invariant/constraint stores (the "heavy" memory tier). */
function decisionDirs(cwd: string): string[] {
	return [
		path.join(cwd, ".pi", "decisions"),
		path.join(os.homedir(), ".pi", "agent", "decisions"),
	];
}

function projectStateFile(cwd: string): string {
	return path.join(cwd, ".pi", "memory", "state.md");
}

const VERIFY_SCRIPT = path.join(os.homedir(), ".pi", "agent", "skills", "memory", "verify.py");

function ragDbDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "rag");
}

const RAG_SCRIPT = path.join(os.homedir(), ".pi", "agent", "skills", "rag", "rag.py");

/** Run rag.py and return its stdout; rejects on non-zero exit or spawn error. */
function runRag(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python3", [RAG_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d) => {
			err += d.toString();
		});
		proc.on("error", (e) => reject(e));
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(err.trim() || `rag.py exit ${code}`));
			else resolve(out);
		});
	});
}

/** Run verify.py and return { code, out }; never rejects on non-zero exit (the report is the value). */
function runVerify(args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python3", [VERIFY_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d) => {
			err += d.toString();
		});
		proc.on("error", (e) => reject(e));
		proc.on("close", (code) => {
			resolve({ code: code ?? 0, out: out + (err ? `\n[stderr] ${err.trim()}` : "") });
		});
	});
}

/**
 * Deterministic secret patterns. Kept specific (not entropy-based) so a note *about* a key or
 * token field is not blocked; only actual credentials are.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; what: string }> = [
	{ re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/, what: "private key block" },
	{ re: /AKIA[0-9A-Z]{16}/, what: "AWS access key id" },
	{ re: /gh[pousr]_[A-Za-z0-9]{36,}/, what: "GitHub token" },
	{ re: /github_pat_[A-Za-z0-9_]{22,}/, what: "GitHub PAT" },
	{ re: /xox[baprs]-[A-Za-z0-9-]{10,}/, what: "Slack token" },
	{ re: /sk-[A-Za-z0-9]{20,}/, what: "API key (sk-…)" },
	{ re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: "JWT" },
	{ re: /(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/_.-]{16,}["']?/i, what: "credential assignment" },
];

function scanForSecrets(text: string): string | null {
	for (const { re, what } of SECRET_PATTERNS) {
		if (re.test(text)) return what;
	}
	return null;
}

/** True when `p` resolves inside a memory dir (project private, safe mirror, global, or a decision store). */
function isMemoryPath(p: string, cwd: string): boolean {
	if (!p) return false;
	const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
	const dirs = [memoryDir(cwd), safeMemoryDir(cwd), memoryGlobalDir(), ...decisionDirs(cwd)];
	return dirs.some((d) => abs === d || abs.startsWith(d + path.sep));
}

/** True when `p` resolves inside a structured decision store. */
function isDecisionPath(p: string, cwd: string): boolean {
	if (!p) return false;
	const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
	return decisionDirs(cwd).some((d) => abs.startsWith(d + path.sep));
}

/** Parse the `status:` field of a decision file's frontmatter; null when absent/unreadable. */
async function decisionStatus(file: string): Promise<string | null> {
	try {
		const raw = await readFile(file, "utf8");
		const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
		if (!m) return null;
		const s = m[1].match(/^status:\s*(\S+)/m);
		return s ? s[1].trim() : null;
	} catch {
		return null;
	}
}

/** FTS5 search over durable memory (global + project); returns the combined result text. */
async function searchMemory(cwd: string, query: string, k: number): Promise<string> {
	const tiers = [
		{ label: "global", dir: memoryGlobalDir(), db: path.join(ragDbDir(), "memory-global.db") },
		{ label: projectKey(cwd), dir: memoryDir(cwd), db: path.join(ragDbDir(), `memory-${projectKey(cwd)}.db`) },
	];
	const parts: string[] = [];
	for (const t of tiers) {
		await ensureMemoryDir(t.dir);
		try {
			await runRag(["index", "--dir", t.dir, "--db", t.db]);
		} catch {
			/* index best-effort */
		}
		try {
			const out = (await runRag(["search", query, "--k", String(k), "--db", t.db])).trim();
			if (out && out !== "[rag] nessun risultato.") parts.push(`— ${t.label} —\n${out}`);
		} catch {
			/* search best-effort */
		}
	}
	return parts.length ? parts.join("\n\n") : `No memory match for "${query}".`;
}

/** Parent-owned consolidation: worker proposes, parent validates + applies atomically. */
async function consolidateProjectMemory(cwd: string): Promise<{ ok: boolean; message: string }> {
	const dir = memoryDir(cwd);
	await ensureMemoryDir(dir);
	const files = (await readdir(dir))
		.filter((f) => f.endsWith(".md") && !["CONSOLIDATED.md", "PROJECT-MEMORY.md", "state.md"].includes(f))
		.slice(0, MAX_MEMORY_FILES);
	if (!files.length) {
		return { ok: false, message: "Nothing to consolidate: no memory files in .pi/memory/" };
	}
	const text = await runConsolidationWorker(cwd, dir);
	if (!text || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
		return { ok: false, message: "Consolidation rejected (empty or oversized) — nothing written" };
	}
	const tmp = path.join(dir, ".consolidated.tmp");
	const dest = path.join(dir, "CONSOLIDATED.md");
	await writeFile(tmp, text, "utf8");
	await rename(tmp, dest);
	const { date, time } = nowParts();
	await appendFile(
		path.join(dir, "LOG.md"),
		`- ${date} ${time} — /consolidate: ${files.length} file(s) → CONSOLIDATED.md (${Buffer.byteLength(text)} bytes)\n`,
		"utf8",
	);
	return { ok: true, message: `Consolidated ${files.length} file(s) → .pi/memory/CONSOLIDATED.md (${Buffer.byteLength(text)} bytes)` };
}

/** Create the memory dir and a self-gitignore so files stay local even if `.pi/` is tracked. */
async function ensureMemoryDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const gi = path.join(dir, ".gitignore");
	try {
		await access(gi);
	} catch {
		await writeFile(gi, "*\n", "utf8");
	}
}

/** Safe mirror: mkdir only, NO self-gitignore — this content is meant to be tracked. */
async function ensureSafeMemoryDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

/** Extract the final assistant text from a `pi --mode json` stdout stream. */
function extractFinalAssistantText(stdout: string): string {
	let last = "";
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const content = ev.message.content;
			if (Array.isArray(content)) {
				const text = content
					.filter((c: any) => c?.type === "text")
					.map((c: any) => c.text)
					.join("");
				if (text) last = text;
			}
		}
	}
	return last.trim();
}

/** Resolve the pi invocation the same way the subagent dispatcher does (binary vs node script). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Spawn a READ-ONLY worker (no bash, no write) and return its consolidated proposal. */
function runConsolidationWorker(cwd: string, memoryDirAbs: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const task = [
			"You are consolidating project memory. Read the markdown files in",
			memoryDirAbs,
			"(skip the .gitignore file). Distill ALL accumulated session notes into ONE",
			"deduplicated, structured markdown document. Keep decisions, outcomes, gotchas,",
			"and anything needed to resume work later; drop noise, duplicates, and superseded",
			"information. Output ONLY the consolidated markdown — no preamble, no commentary.",
		].join(" ");
		const args = ["--mode", "json", "-p", "--no-session", "--tools", "read,ls,find,grep", task];
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d) => {
			err += d.toString();
		});
		proc.on("error", (e) => reject(e));
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`consolidation worker exit ${code}: ${err.slice(-400)}`));
			} else {
				resolve(extractFinalAssistantText(out));
			}
		});
	});
}

export default function (pi: ExtensionAPI): void {
	const isTui = (mode: string): boolean => mode === "tui";

	// 7) Secret scanning + decision protection: one tool_call handler for both write/edit guards.
	pi.on("tool_call", async (event, ctx) => {
		let target = "";
		let candidate = "";
		if (isToolCallEventType("write", event)) {
			target = event.input.path;
			candidate = event.input.content;
		} else if (isToolCallEventType("edit", event)) {
			target = event.input.path;
			candidate = (event.input.edits ?? []).map((e) => `${e.newText ?? ""}\n${e.oldText ?? ""}`).join("\n");
		} else {
			return;
		}

		// Secret scanning: block persisting a credential into any memory/decision dir.
		if (isMemoryPath(target, ctx.cwd)) {
			const secret = scanForSecrets(candidate);
			if (secret) {
				return { block: true, reason: `secret scan: ${secret} in a memory file — not written` };
			}
		}

		// Decision protection: validated decisions are append-only (supersede, never edit).
		if (isDecisionPath(target, ctx.cwd)) {
			const abs = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
			if (existsSync(abs)) {
				const status = await decisionStatus(abs);
				if (status === "validated") {
					return {
						block: true,
						reason: `protected decision: ${abs} is status=validated and append-only. Do not edit it — write a new DEC-*.md with supersedes: <id> to replace it.`,
					};
				}
			}
		}
	});

	// 1) Automatic snapshot: persist each compaction summary (already paid for by pi).
	pi.on("session_compact", async (event, ctx) => {
		if (!isTui(ctx.mode)) return;
		const summary = (event as any)?.compactionEntry?.summary;
		if (!summary) return;
		try {
			const dir = memoryDir(ctx.cwd);
			await ensureMemoryDir(dir);
			const { date, time } = nowParts();
			const file = path.join(dir, `${projectKey(ctx.cwd)}-${date}.md`);
			await appendFile(file, `\n## ${date} ${time} — session compact\n\n${summary}\n`, "utf8");

			// L2 current state: a single authoritative resume point (the latest summary).
			await writeFile(
				projectStateFile(ctx.cwd),
				`# State — resume point (${date} ${time})\n\n` +
					`Decisions/invariants live in .pi/decisions/ (authoritative, L1) — this file references them, never redefines them.\n\n` +
					`${summary}\n`,
				"utf8",
			);

			// 12) Re-verify the decisions cited in the compacted span, so their evidence trail
			//     stays fresh exactly where the work happened. Best-effort: a single decision's
			//     verification must never break compaction.
			const cited = [...new Set(summary.match(/\bDEC-\d+\b/g) ?? [])].slice(0, 10);
			for (const id of cited) {
				try {
					await runVerify(["check", id]);
				} catch {
					/* ignore per-decision failures */
				}
			}
		} catch {
			/* best-effort; never break pi */
		}
	});

	// 2) On-demand note appended to the project log (private, not versioned).
	pi.registerCommand("note", {
		description: "Append a dated note to the project memory log (.pi/memory/LOG.md)",
		handler: async (args, ctx) => {
			if (!isTui(ctx.mode)) {
				ctx.ui.notify("/note requires interactive mode", "error");
				return;
			}
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /note <what you did / next step>", "error");
				return;
			}
			const secret = scanForSecrets(text);
			if (secret) {
				ctx.ui.notify(`Blocked: possible ${secret} in note — not saved`, "error");
				return;
			}
			try {
				const dir = memoryDir(ctx.cwd);
				await ensureMemoryDir(dir);
				const { date, time } = nowParts();
				await appendFile(path.join(dir, "LOG.md"), `- ${date} ${time} — ${text}\n`, "utf8");
				ctx.ui.notify("Note saved to .pi/memory/LOG.md", "info");
			} catch (err) {
				ctx.ui.notify(`Could not save note: ${(err as Error).message}`, "error");
			}
		},
	});

	// 4) Safe mirror: only explicitly-safe content, git-tracked under .memory/.
	pi.registerCommand("note-safe", {
		description: "Append a dated note to the GIT-TRACKED safe memory (.memory/SAFE.md) — only explicitly-safe content",
		handler: async (args, ctx) => {
			if (!isTui(ctx.mode)) {
				ctx.ui.notify("/note-safe requires interactive mode", "error");
				return;
			}
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /note-safe <what to commit as safe project memory>", "error");
				return;
			}
			const secret = scanForSecrets(text);
			if (secret) {
				ctx.ui.notify(`Blocked: possible ${secret} in safe note — not saved`, "error");
				return;
			}
			try {
				const dir = safeMemoryDir(ctx.cwd);
				await ensureSafeMemoryDir(dir);
				const { date, time } = nowParts();
				await appendFile(path.join(dir, "SAFE.md"), `- ${date} ${time} — ${text}\n`, "utf8");
				ctx.ui.notify("Safe note saved to .memory/SAFE.md (git-tracked)", "info");
			} catch (err) {
				ctx.ui.notify(`Could not save safe note: ${(err as Error).message}`, "error");
			}
		},
	});

	// 5) Parent-owned consolidation: worker proposes, parent validates + applies atomically.
	pi.registerCommand("consolidate", {
		description: "Distill .pi/memory/*.md into CONSOLIDATED.md (read-only worker proposes, parent applies atomically)",
		handler: async (args, ctx) => {
			if (!isTui(ctx.mode)) {
				ctx.ui.notify("/consolidate requires interactive mode", "error");
				return;
			}
			try {
				ctx.ui.notify("Consolidating project memory…", "info");
				const res = await consolidateProjectMemory(ctx.cwd);
				ctx.ui.notify(res.message, res.ok ? "info" : "error");
			} catch (err) {
				ctx.ui.notify(`Consolidation failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// 6) /memory <query> — FTS5 search over durable memory (global + project), reusing rag.py.
	pi.registerCommand("memory", {
		description: "Search durable memory (global + project) via FTS5 (reuses rag.py)",
		handler: async (args, ctx) => {
			if (!isTui(ctx.mode)) {
				ctx.ui.notify("/memory requires interactive mode", "error");
				return;
			}
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /memory <query>", "error");
				return;
			}
			try {
				const text = await searchMemory(ctx.cwd, query, 5);
				if (text.startsWith("No memory match")) {
					ctx.ui.notify(text, "info");
				} else {
					ctx.ui.setWidget("memory", text.split("\n").slice(0, 60));
				}
			} catch (err) {
				ctx.ui.notify(`Memory search failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// 8) Model-callable tools: the agent can search / consolidate durable memory itself,
	//    not only via the human-facing commands. memory_search is read-only; consolidate is
	//    a low-stakes hygiene write under the gitignored .pi/memory/ (original files kept).
	pi.registerTool({
		name: "memory_search",
		label: "Search memory",
		description: "Search durable memory (global ~/.pi/agent/memory/ + project .pi/memory/) via FTS5. Use to recall facts, preferences, corrections, failures or past decisions instead of re-deriving them. Returns snippets with their source tier.",
		parameters: Type.Object({
			query: Type.String({ description: "What to search for in durable memory" }),
			k: Type.Optional(Type.Number({ description: "Max results per tier (default 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const k = Math.min(Math.max(Number(params.k ?? 5), 1), 20);
				const text = await searchMemory(ctx.cwd, String(params.query), k);
				return { content: [{ type: "text", text }], details: {} };
			} catch (err) {
				return { content: [{ type: "text", text: `memory_search errore: ${(err as Error).message}` }], details: {} };
			}
		},
	});

	pi.registerTool({
		name: "memory_consolidate",
		label: "Consolidate memory",
		description: "Distill the project's .pi/memory/*.md work-log into one deduplicated CONSOLIDATED.md (a read-only worker proposes, the parent applies atomically; original files are kept). Use only when many dated memory files have accumulated and search is getting noisy — it spawns a worker, so not on every turn.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const res = await consolidateProjectMemory(ctx.cwd);
				return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
			} catch (err) {
				return { content: [{ type: "text", text: `memory_consolidate errore: ${(err as Error).message}` }], details: {} };
			}
		},
	});

	// 10) verify_decisions — evidence-based verification of validated decisions/invariants
	//     against their L0 evidence (auto/read/human), via verify.py.
	pi.registerTool({
		name: "verify_decisions",
		label: "Verify decisions",
		description: "Verify validated decisions/invariants against their L0 evidence via verify.py. auto = run the decision's read-only verify_command; read = check evidence files + anchor; human = flagged for re-confirmation. Writes the verification trail to <decisions-dir>/verification.json (derived, gitignored). Use BEFORE modifying something a decision covers, AFTER recording a new decision, and to detect a stale L0↔L1 conflict.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Verify a single decision id (e.g. DEC-0001); omit to verify all." })),
			dir: Type.Optional(Type.String({ description: "Decisions dir to scan (default: project .pi/decisions + global ~/.pi/agent/decisions)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const args: string[] = ["check"];
				const id = params.id ? String(params.id).trim() : "";
				if (id) args.push(id);
				const dir = params.dir ? String(params.dir).trim() : "";
				if (dir) args.push("--dir", dir);
				const { code, out } = await runVerify(args);
				return { content: [{ type: "text", text: out || "(verify produced no output)" }], details: { exitCode: code } };
			} catch (err) {
				return { content: [{ type: "text", text: `verify_decisions errore: ${(err as Error).message}` }], details: {} };
			}
		},
	});

	// 11) Resume pointer: surface the durable L2 state so a fresh/resumed session continues
	//     from state, not from conversation history. Injected once per turn, chained with
	//     routing.ts's block (both modify event.systemPrompt, which composes across handlers).
	pi.on("before_agent_start", async (event, ctx) => {
		const MARKER = "<!-- pi-state -->";
		if (event.systemPrompt.includes(MARKER)) return;
		const stateFile = projectStateFile(ctx.cwd);
		if (!existsSync(stateFile)) return;
		try {
			const st = statSync(stateFile);
			const age = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 86_400_000));
			return {
				systemPrompt:
					event.systemPrompt +
					`\n\n${MARKER}\n## Project state (L2)\nA durable resume state exists at ${stateFile} (${age}d old). If this session is resuming prior work, read it first — continue from state, not from conversation history. Decisions/invariants live in .pi/decisions/ (authoritative, L1): verify before contradicting them (tool \`verify_decisions\`).`,
			};
		} catch {
			/* best-effort */
		}
	});
}
