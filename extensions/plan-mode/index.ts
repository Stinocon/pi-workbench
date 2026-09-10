/**
 * Plan Mode — global extension.
 *
 * Read-only exploration mode with a dispatch-integrated execution phase:
 *   - /plan (or Ctrl+Alt+P, or --plan flag) toggles read-only exploration.
 *   - the `plan_mode` TOOL lets the agent enter plan mode itself (and request exit,
 *     which is user-confirmed) — the user no longer has to type /plan first.
 *   - While active: edit/write are disabled, bash is allowlisted to read-only
 *     commands, Home Assistant write/delete tools are blocked, and
 *     subagent/delegate offloads are blocked (no writes from cold workers).
 *   - The agent produces a numbered `Plan:` with an optional dispatch effort
 *     tier tag per step (e.g. `1. [high] Rewrite the parser ...`).
 *   - On approval, execution restores full access and routes each step through
 *     the dispatch skill: mechanical/independent steps to the matching
 *     miner-* worker via `subagent`, correctness-critical / security / HA-write
 *     / shared-context steps stay inline on the cloud primary. `[DONE:n]`
 *     markers track completion.
 *
 * The read-only gate is a workflow guardrail, not a security sandbox (see
 * utils.ts). State persists across session resume via appendEntry.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.ts";

// Built-in / offload tools that must never run in plan mode.
const READ_ONLY_BLOCKED_TOOLS = new Set(["edit", "write", "subagent", "delegate"]);

// Home Assistant write/delete tools (matched by suffix so a namespace prefix
// cannot defeat the block).
const HA_WRITE_TOOL_SUFFIXES = [
	"ha_config_set_automation",
	"ha_call_write_tool",
	"ha_call_delete_tool",
];
const HA_BACKUP_TOOL_SUFFIX = "ha_manage_backup";
const HA_BACKUP_DESTRUCTIVE_ACTIONS = new Set(["create", "restore", "delete"]);

interface PlanModeState {
	enabled: boolean;
	todos: TodoItem[];
	executing: boolean;
	toolsBeforePlanMode?: string[];
}

function unique(names: string[]): string[] {
	return [...new Set(names)];
}

// --- Loose message type guards (avoid brittle deep-import types) ------------

interface AssistantLike {
	role: string;
	content: unknown;
}

function isAssistantLike(m: unknown): m is AssistantLike {
	return (
		!!m &&
		typeof m === "object" &&
		(m as { role?: unknown }).role === "assistant"
	);
}

function getTextContent(m: AssistantLike): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter(
				(b): b is { type: string; text?: string } =>
					!!b && typeof b === "object" && (b as { type?: unknown }).type === "text",
			)
			.map((b) => b.text ?? "")
			.join("\n");
	}
	return "";
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// --- Tool set management -------------------------------------------------

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(
			unique([
				...toolsBeforePlanMode.filter((n) => !READ_ONLY_BLOCKED_TOOLS.has(n)),
				"read",
				"bash",
			]),
		);
	}

	function restoreNormalModeTools(): void {
		if (toolsBeforePlanMode) {
			pi.setActiveTools(toolsBeforePlanMode);
		} else {
			pi.setActiveTools(unique(["read", "bash", "edit", "write", ...pi.getActiveTools()]));
		}
		toolsBeforePlanMode = undefined;
	}

	// --- UI ------------------------------------------------------------------

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				const prefix = item.tier ? `[${item.tier}] ` : "";
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(prefix + item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${prefix}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
		});
	}

	// --- Toggle --------------------------------------------------------------

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled — read-only. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled — full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No active plan. Enable /plan and ask the agent to produce a Plan:.", "info");
				return;
			}
			const list = todoItems
				.map((t, i) => {
					const tier = t.tier ? ` [${t.tier}]` : "";
					return `${i + 1}.${tier} ${t.completed ? "✓" : "○"} ${t.text}`;
				})
				.join("\n");
			ctx.ui.notify(`Plan progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// --- Model-driven toggle: the agent can enter/exit plan mode itself ---------
	// Entering is always safe (it only restricts). Exiting re-enables writes, so it
	// asks for confirmation — otherwise plan mode's "approve before writes" guardrail
	// would be a switch the model can silently flip off.
	pi.registerTool({
		name: "plan_mode",
		label: "Plan mode",
		description: [
			"Enter or exit read-only plan mode.",
			"ENTER (enabled: true): before a large, multi-step or risky change, explore read-only and produce a numbered Plan: with [tier] tags. While enabled, edit/write/subagent/delegate are blocked and bash is allowlisted to read-only commands.",
			"EXIT (enabled: false): after the user approves the plan, restore full tool access and execute. Exit asks for confirmation because it re-enables writes.",
		].join(" "),
		parameters: Type.Object({
			enabled: Type.Boolean({ description: "true = enter plan mode (read-only); false = exit and restore full tools" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const want = params.enabled === true;
			if (want === planModeEnabled) {
				return {
					content: [{ type: "text", text: `Plan mode is already ${want ? "enabled" : "disabled"}.` }],
					details: {},
				};
			}
			if (!want && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Exit plan mode?",
					"Restores edit/write and Home Assistant write access. Continue only if the plan was approved.",
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Plan mode stays enabled (exit not confirmed)." }],
						details: {},
					};
				}
			}
			togglePlanMode(ctx);
			return {
				content: [
					{
						type: "text",
						text: want
							? "Plan mode enabled — read-only. Explore and produce a numbered Plan: with [tier] tags; make no changes until approved."
							: "Plan mode disabled — full tool access restored.",
					},
				],
				details: {},
			};
		},
	});

	// --- Read-only gate ------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		const name = event.toolName;

		if (READ_ONLY_BLOCKED_TOOLS.has(name)) {
			return {
				block: true,
				reason: `Plan mode: ${name} is blocked (read-only). Run /plan to exit plan mode before making changes.`,
			};
		}

		if (HA_WRITE_TOOL_SUFFIXES.some((s) => name.endsWith(s))) {
			return {
				block: true,
				reason: `Plan mode: ${name} is a Home Assistant write tool and is blocked (read-only).`,
			};
		}

		if (name.endsWith(HA_BACKUP_TOOL_SUFFIX)) {
			const action = (event.input as { action?: string })?.action;
			if (action && HA_BACKUP_DESTRUCTIVE_ACTIONS.has(action)) {
				return {
					block: true,
					reason: `Plan mode: ha_manage_backup ${action} is blocked (read-only). list/view/diff are allowed.`,
				};
			}
			return;
		}

		if (name.endsWith("doc_to_markdown")) {
			const output = (event.input as { output?: string })?.output;
			if (output) {
				return {
					block: true,
					reason: "Plan mode: doc_to_markdown with `output` writes a file and is blocked. Omit `output` to return markdown inline.",
				};
			}
			return;
		}

		if (name === "bash") {
			const command = (event.input as { command?: string })?.command ?? "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: bash command blocked (not read-only allowlisted).\nCommand: ${command}`,
				};
			}
		}
	});

	// --- Filter stale plan-mode context when out of plan mode ----------------

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string; role?: string; content?: unknown };
				if (msg.customType === "plan-mode-context" || msg.customType === "plan-execution-context") {
					return false;
				}
				if (msg.role !== "user") return true;
				const c = msg.content;
				if (typeof c === "string") {
					return !c.includes("[PLAN MODE ACTIVE]") && !c.includes("[EXECUTING PLAN");
				}
				if (Array.isArray(c)) {
					return !c.some(
						(b) =>
							!!b &&
							typeof b === "object" &&
							(b as { type?: unknown }).type === "text" &&
							((b as { text?: string }).text ?? "").includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// --- Context injection ---------------------------------------------------

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode — read-only exploration. Do NOT modify files, run mutating commands, call Home Assistant write/delete services, or offload work.

Enforced restrictions:
- edit/write tools are disabled
- bash is allowlisted to read-only commands
- Home Assistant write/delete tools are blocked
- subagent/delegate offloads are blocked

Explore the codebase, understand the request, and produce a concrete plan. Output it as a numbered list under a "Plan:" header. Pre-classify each step with a dispatch effort tier in square brackets at the start (low | medium | high | xhigh | max), so execution can route it to the right worker:

Plan:
1. [high] Rewrite the parser to handle edge cases
2. [low] Update README links
3. ...

Do NOT attempt any change — describe what you would do, step by step.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining
				.map((t) => `${t.step}.${t.tier ? ` [${t.tier}]` : ""} ${t.text}`)
				.join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN — full tool access restored]

Remaining steps:
${todoList}

Route each step through the dispatch skill:
- Delegate mechanical / independent / retrieval steps to the matching miner-* worker via the subagent tool, in parallel batches where independent.
- Keep inline on yourself (cloud primary): correctness-critical code, security reasoning, Home Assistant writes/renames, shared-context and tightly-coupled work.
- The [tier] tag (low/medium/high/xhigh/max) is a pre-classification hint — route by it, but override if a step's real difficulty differs.
- Never trust a worker's output blindly: verify against source/evidence, then integrate. A green worker is not a green combination.

Execute the steps in order. After a step is fully completed AND verified, include a [DONE:n] tag in your response (n = step number).`,
					display: false,
				},
			};
		}
	});

	// --- Progress tracking ---------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantLike(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// --- Plan extraction + approval flow ------------------------------------

	pi.on("agent_end", async (event, ctx) => {
		// Execution finished — clear state if every step is done.
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan complete ✓**\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract a Plan: from the last assistant message.
		const lastAssistant = [...event.messages].reverse().find(isAssistantLike);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}
		if (todoItems.length === 0) return;
		persistState();

		const todoListText = todoItems
			.map((t, i) => `${i + 1}.${t.tier ? ` [${t.tier}]` : ""} ☐ ${t.text}`)
			.join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode — what next?", [
			"Execute the plan (dispatch-routed)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const first = todoItems[0];
			if (!first) return;

			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems
				.map((t) => `${t.step}.${t.tier ? ` [${t.tier}]` : ""} ${t.text}`)
				.join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${first.text}
Route each step through the dispatch skill (delegate mechanical/independent steps to miner-* workers; keep correctness-critical/security/HA-write steps inline). After each completed and verified step, include a [DONE:n] tag.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// --- Restore state on session start/resume ------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter(
				(e): e is { type: string; customType?: string; data?: PlanModeState } =>
					(e as { type?: unknown }).type === "custom" &&
					(e as { customType?: unknown }).customType === "plan-mode",
			)
			.pop();

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// On resume, re-scan messages AFTER the last "plan-mode-execute" marker to
		// rebuild [DONE:n] completion state without picking up prior plans.
		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { customType?: string }).customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}
			const texts: string[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i] as { type?: string; message?: unknown };
				if (entry.type === "message" && isAssistantLike(entry.message)) {
					texts.push(getTextContent(entry.message as AssistantLike));
				}
			}
			markCompletedSteps(texts.join("\n"), todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
