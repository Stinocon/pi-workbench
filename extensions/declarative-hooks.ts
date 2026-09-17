/**
 * declarative-hooks.ts — Declarative shell hooks (local stopgap).
 *
 * Lets non-TS users hook the agent lifecycle with plain shell scripts, in the
 * spirit of Codex Hooks. Reads ~/.pi/agent/hooks.json and runs each hook's
 * command through `/bin/sh -c`.
 *
 * Config format (see hooks.example.json at the repo root):
 *   {
 *     "hooks": [
 *       { "event": "tool_call", "tool": "bash", "command": "..." },
 *       { "event": "tool_execution_end", "tool": "*", "command": "..." },
 *       { "event": "session_before_compact", "command": "..." }
 *     ]
 *   }
 *
 * Events:
 *   tool_call             — non-zero exit blocks the tool (pre-execution)
 *   session_before_compact — non-zero exit cancels compaction
 *   tool_execution_start / tool_execution_end / before_agent_start — side effects (audit/log)
 *
 * Script contract: run as `/bin/sh -c <command> pi-hook <event> <tool> <input>`.
 * Inside the script: $1 = event, $2 = tool name ("" if none), $3 = JSON tool
 * input (tool_call only). Exit 0 = allow, non-zero = block/cancel; the block
 * reason is read from stderr, else the last non-empty stdout line.
 *
 * Changes to hooks.json require /reload.
 *
 * Stopgap: if Pi gains native declarative hooks, adopt them and discard this.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface HookSpec {
	event: string;
	tool?: string;
	command: string;
}

interface HooksConfig {
	hooks?: HookSpec[];
}

const HOOK_TIMEOUT_MS = 10_000;

function configPath(): string {
	return join(homedir(), ".pi", "agent", "hooks.json");
}

function loadConfig(): HooksConfig {
	const p = configPath();
	if (!existsSync(p)) return {};
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as HooksConfig;
		return parsed && Array.isArray(parsed.hooks) ? parsed : {};
	} catch {
		return {};
	}
}

const config = loadConfig();
const hooks = config.hooks ?? [];

function matches(spec: HookSpec, toolName: string): boolean {
	return spec.tool === undefined || spec.tool === "*" || spec.tool === toolName;
}

function hooksFor(event: string, toolName: string): HookSpec[] {
	return hooks.filter((h) => h.event === event && matches(h, toolName));
}

async function runHook(
	pi: ExtensionAPI,
	spec: HookSpec,
	event: string,
	toolName: string,
	input: string,
): Promise<{ blocked: boolean; reason?: string }> {
	let result;
	try {
		result = await pi.exec(
			"/bin/sh",
			["-c", spec.command, "pi-hook", event, toolName, input],
			{ timeout: HOOK_TIMEOUT_MS },
		);
	} catch (error) {
		return { blocked: true, reason: `hook failed to run: ${String(error)}` };
	}

	if (result.code === 0) return { blocked: false };

	const reason =
		result.stderr.trim() ||
		result.stdout.trim().split("\n").filter(Boolean).pop() ||
		`hook exited with code ${result.code}`;
	return { blocked: true, reason };
}

export default function (pi: ExtensionAPI) {
	if (hooks.length === 0) return;

	// Block-capable: tool_call (pre-execution).
	pi.on("tool_call", async (event) => {
		const input = JSON.stringify(event.input);
		for (const spec of hooksFor("tool_call", event.toolName)) {
			const r = await runHook(pi, spec, "tool_call", event.toolName, input);
			if (r.blocked) return { block: true, reason: r.reason };
		}
	});

	// Cancel-capable: session_before_compact.
	pi.on("session_before_compact", async () => {
		for (const spec of hooksFor("session_before_compact", "")) {
			const r = await runHook(pi, spec, "session_before_compact", "", "");
			if (r.blocked) return { cancel: true };
		}
	});

	// Side-effect (audit/log) events.
	pi.on("tool_execution_start", async (event) => {
		for (const spec of hooksFor("tool_execution_start", event.toolName)) {
			await runHook(pi, spec, "tool_execution_start", event.toolName, "");
		}
	});

	pi.on("tool_execution_end", async (event) => {
		for (const spec of hooksFor("tool_execution_end", event.toolName)) {
			await runHook(pi, spec, "tool_execution_end", event.toolName, "");
		}
	});

	pi.on("before_agent_start", async () => {
		for (const spec of hooksFor("before_agent_start", "")) {
			await runHook(pi, spec, "before_agent_start", "", "");
		}
	});
}
