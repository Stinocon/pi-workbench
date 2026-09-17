/**
 * verify-gates.ts — Deterministic task verification (P1, local).
 *
 * Turns the "done = green gate" policy into a mechanism. A project declares its
 * deterministic gates (lint/test/build) in `.pi/verify.json`; this extension runs
 * them and treats the exit code as the only verdict — no LLM self-grading.
 *
 * Components:
 *   - `verify_gates` tool — the agent runs the gates mid-task to see pass/fail.
 *   - `/verify` command — the user runs the gates manually.
 *   - `agent_settled` hook — after a run that wrote files, re-runs the gates:
 *       * report mode (default): notifies "verification failed" (TUI).
 *       * enforce mode (`pi --verify-enforce`): feeds the failure back to the
 *         agent to fix, up to `maxIterations` (default 3).
 *
 * Config (`.pi/verify.json`, discovered walking up from the working directory):
 *   { "gates": [{ "name": "lint", "command": "npm run lint" }],
 *     "timeoutMs": 120000, "maxIterations": 3 }
 *
 * No config = inert. Enforce is opt-in via flag only: a repo can never trigger
 * loops on its own. Deterministic-only by design (no LLM-as-judge).
 *
 * Stopgap: if Pi gains a native verification/eval primitive, adopt it and
 * discard this extension.
 */

import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execP = promisify(exec);

interface GateSpec {
	name: string;
	command: string;
}

interface VerifyConfig {
	gates?: GateSpec[];
	timeoutMs?: number;
	maxIterations?: number;
}

interface GateResult {
	name: string;
	command: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	passed: boolean;
	timedOut?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_OUTPUT_CHARS = 4000;

function findConfig(startDir: string): { config: VerifyConfig } | null {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, ".pi", "verify.json");
		if (existsSync(candidate)) {
			try {
				const parsed = JSON.parse(readFileSync(candidate, "utf8")) as VerifyConfig;
				return parsed && Array.isArray(parsed.gates) ? { config: parsed } : null;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // filesystem root reached
		dir = parent;
	}
}

async function runGate(cwd: string, gate: GateSpec, timeoutMs: number): Promise<GateResult> {
	try {
		const { stdout, stderr } = await execP(gate.command, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			env: process.env,
		});
		return { name: gate.name, command: gate.command, exitCode: 0, stdout, stderr, passed: true };
	} catch (error) {
		const e = error as {
			code?: number | string;
			killed?: boolean;
			signal?: string;
			stdout?: string;
			stderr?: string;
		};
		const timedOut = e.killed === true || (e.signal != null && e.signal !== "SIGTERM");
		const exitCode = typeof e.code === "number" ? e.code : null;
		return {
			name: gate.name,
			command: gate.command,
			exitCode,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			passed: false,
			timedOut,
		};
	}
}

function truncate(s: string): string {
	if (s.length <= MAX_OUTPUT_CHARS) return s;
	return `${s.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

function formatResults(results: GateResult[]): string {
	const lines: string[] = [];
	for (const r of results) {
		const status = r.timedOut ? "TIMEOUT" : r.passed ? "PASS" : "FAIL";
		lines.push(`[${status}] ${r.name}  (exit ${r.exitCode ?? "?"})`);
		if (!r.passed) {
			const detail = r.stderr.trim() || r.stdout.trim() || "(no output)";
			lines.push(...truncate(detail).split("\n").map((l) => `    ${l}`));
		}
	}
	const failed = results.filter((r) => !r.passed).length;
	lines.push("");
	lines.push(failed === 0 ? "All gates passed." : `${failed}/${results.length} gate(s) failed.`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("verify-enforce", {
		type: "boolean",
		default: false,
		description:
			"After a run that writes files, auto-feed failing gates back to the agent to fix (up to maxIterations).",
	});

	let dirty = false;
	let iterations = 0;

	pi.on("session_start", () => {
		iterations = 0;
	});

	pi.on("agent_start", () => {
		dirty = false;
	});

	pi.on("tool_call", (event) => {
		if (event.toolName === "write" || event.toolName === "edit") dirty = true;
	});

	const verifyTool = defineTool({
		name: "verify_gates",
		label: "Verify gates",
		description:
			"Run this project's deterministic verification gates (declared in .pi/verify.json, e.g. lint/test/build). " +
			"Returns pass/fail per gate from the real exit codes — no self-assessment. Use it before claiming a task is done. " +
			"Not for decision verification (that is verify_decisions).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const found = findConfig(ctx.cwd);
			if (!found) {
				return {
					content: [
						{ type: "text", text: "No .pi/verify.json found in this project — no gates declared." },
					],
				};
			}
			const timeoutMs = found.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const results: GateResult[] = [];
			for (const gate of found.config.gates ?? []) {
				results.push(await runGate(ctx.cwd, gate, timeoutMs));
			}
			const passed = results.every((r) => r.passed);
			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { passed },
			};
		},
	});
	pi.registerTool(verifyTool);

	pi.registerCommand("verify", {
		description: "Run this project's verification gates now",
		handler: async (_args, ctx) => {
			const found = findConfig(ctx.cwd);
			if (!found) {
				ctx.ui.notify("No .pi/verify.json found — no gates declared.", "info");
				return;
			}
			const timeoutMs = found.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const results: GateResult[] = [];
			for (const gate of found.config.gates ?? []) {
				results.push(await runGate(ctx.cwd, gate, timeoutMs));
			}
			const passed = results.every((r) => r.passed);
			const failedNames = results.filter((r) => !r.passed).map((r) => r.name).join(", ");
			ctx.ui.notify(
				passed ? "Verification passed." : `Verification failed: ${failedNames}`,
				passed ? "info" : "error",
			);
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!dirty) return;
		const found = findConfig(ctx.cwd);
		if (!found || (found.config.gates ?? []).length === 0) return;

		const timeoutMs = found.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const results: GateResult[] = [];
		for (const gate of found.config.gates ?? []) {
			results.push(await runGate(ctx.cwd, gate, timeoutMs));
		}
		if (results.every((r) => r.passed)) return;

		const failedNames = results.filter((r) => !r.passed).map((r) => r.name).join(", ");
		console.error(`[verify-gates] FAILED: ${failedNames}`);

		if (!pi.getFlag("verify-enforce")) {
			ctx.ui.notify(`Verification failed: ${failedNames}`, "error");
			return;
		}

		const max = found.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		if (iterations >= max) {
			ctx.ui.notify(
				`Verification still failing after ${iterations} iteration(s): ${failedNames}`,
				"error",
			);
			iterations = 0;
			return;
		}

		iterations += 1;
		const detail = formatResults(results);
		// Defer so the message lands after settlement completes (re-entrancy guard).
		setTimeout(() => {
			pi.sendUserMessage(
				`Verification failed (${failedNames}). Iteration ${iterations}/${max}.\n\n` +
					`Fix the failures below, then re-verify with the verify_gates tool.\n\n` +
					truncate(detail),
			);
		}, 0);
	});
}
