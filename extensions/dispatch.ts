/**
 * /dispatch <task> — preflight effort calibration.
 *
 * Injects into the editor (as a draft, not auto-run) the calibrated dispatch plan
 * for a non-trivial task: task -> miner-* tier (model + effort), what to delegate
 * and what to keep inline. The user reviews/edits before submitting.
 *
 * This is the operator-facing front door to the `dispatch` skill and the `miner-*`
 * workers. It does not execute anything by itself — it drafts the plan to confirm,
 * which is the protocol in the dispatch skill (confirm before starting).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TIER_FALLBACK = [
	{ worker: "miner-low", model: "<your-fast-model>", effort: "low", thinking: "minimal", use: "retrieval, extraction, reformatting, mechanical" },
	{ worker: "miner-medium", model: "<your-mid-model>", effort: "medium", thinking: "medium", use: "straightforward changes, porting, docs" },
	{ worker: "miner-high", model: "<your-primary-model>", effort: "high", thinking: "high", use: "code that must be correct (default for real code)" },
	{ worker: "miner-xhigh", model: "<your-review-model>", effort: "xhigh", thinking: "xhigh", use: "adversarial review, audit" },
	{ worker: "miner-max", model: "<your-max-model>", effort: "max", thinking: "max", use: "longest, highest-stakes reasoning" },
];

function planText(task: string): string {
	const lines = [
		"## Dispatch plan — confirm before executing",
		"",
		`**Task:** ${task.trim()}`,
		"",
		"I'll split this into tiers and delegate the mechanical slices to the `miner-*` workers in a",
		"parallel `subagent` batch, keeping only the correctness-critical core inline.",
		"",
		"### Candidate tier mapping",
		"",
		"| Slice | Worker | Model | Effort | Thinking |",
		"|-------|--------|-------|--------|----------|",
	];
	for (const t of TIER_FALLBACK) {
		lines.push(`| ${t.use} | \`${t.worker}\` | \`${t.model}\` | ${t.effort} | ${t.thinking} |`);
	}
	lines.push(
		"",
		"**Adjust the mapping to this specific task, then submit.** Override the model if what matters",
		"is a model's specific competence rather than difficulty. Never use a stronger tier than needed.",
		"",
		"Rationale (dispatch skill): mechanical work does not run on the frontier model; correctness",
		"never drops below `miner-high`; heavy coupling stays inline because a cold worker costs more",
		"than the tier it saves.",
	);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dispatch", {
		description: "Draft a calibrated effort plan for a task (miner-* tier mapping)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/dispatch requires interactive mode", "error");
				return;
			}
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /dispatch <task>", "error");
				return;
			}
			const plan = planText(task);
			ctx.ui.setEditorText(plan);
			ctx.ui.notify("Dispatch plan drafted — review and submit.", "info");
		},
	});
}