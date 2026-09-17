/**
 * tool-risk.ts — Risk annotations for built-in tools + opt-in confirm (local stopgap).
 *
 * Local, disposable implementation of MCP-style tool risk annotations
 * (readOnlyHint / destructiveHint / idempotentHint / openWorldHint). These are
 * NOT first-class fields on ToolDefinition (that needs core); this extension
 * keeps a deterministic table instead and consumes it in two ways:
 *
 *   1. `/risk` command — prints the table so the risk is visible on demand.
 *   2. Opt-in confirmation — with `pi --confirm-destructive`, tools flagged
 *      `destructive` ask for confirmation before running (interactive only).
 *
 * Philosophy: no hard permission boundary (matching Pi's security model), but
 * risk is made explicit and can be surfaced. Default is OFF: nothing blocks
 * unless you pass `--confirm-destructive`.
 *
 * Stopgap: if Pi adopts native tool annotations, adopt them and discard this.
 */

import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

interface Risk {
	readOnly?: boolean;
	destructive?: boolean;
	idempotent?: boolean;
	openWorld?: boolean;
}

/** Deterministic risk table for Pi's built-in tools. */
const RISK: Record<string, Risk> = {
	read: { readOnly: true, idempotent: true },
	grep: { readOnly: true, idempotent: true },
	find: { readOnly: true, idempotent: true },
	ls: { readOnly: true, idempotent: true },
	write: { destructive: true },
	edit: { destructive: true },
	bash: { destructive: true, openWorld: true },
	powershell: { destructive: true, openWorld: true },
};

function describe(risk: Risk | undefined): string {
	if (!risk) return "unannotated";
	const flags = [
		risk.readOnly && "readOnly",
		risk.destructive && "destructive",
		risk.idempotent && "idempotent",
		risk.openWorld && "openWorld",
	].filter(Boolean);
	return flags.length > 0 ? flags.join(", ") : "none";
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("confirm-destructive", {
		type: "boolean",
		default: false,
		description:
			"Ask for confirmation before running tools flagged destructive (write/edit/bash/powershell).",
	});

	// Opt-in confirmation on destructive tools, interactive mode only.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!ctx.hasUI) return;
		if (!pi.getFlag("confirm-destructive")) return;

		const risk = RISK[event.toolName];
		if (!risk?.destructive) return;

		const confirmed = await ctx.ui.confirm(
			`Run ${event.toolName}?`,
			"This tool is flagged destructive: it can modify files or execute commands.",
		);

		if (!confirmed) {
			return { block: true, reason: `User declined ${event.toolName} (destructive)` };
		}
	});

	// Inspect the risk table on demand.
	pi.registerCommand("risk", {
		description: "Show risk annotations for built-in tools",
		handler: async (_args, ctx) => {
			const lines = Object.entries(RISK).map(
				([name, risk]) => `${name}: ${describe(risk)}`,
			);
			ctx.ui.notify(lines.join(" | "), "info");
		},
	});
}
