/**
 * compact-tool.ts — Model-callable context compaction (local stopgap).
 *
 * Exposes a `compact` tool so the agent can request session compaction
 * between subtasks, before ingesting a large amount of new context, instead
 * of waiting for the automatic threshold compaction to trigger.
 *
 * Why it only SCHEDULES: manual compaction (`ctx.compact()`) aborts the
 * current run and never resumes it. Calling it from inside the tool's
 * execute() would kill the very turn that requested the compaction. Instead
 * the tool sets a flag, and an `agent_end` handler fires the real compaction
 * once the run has settled.
 *
 * Stopgap: if Pi gains a native "compact at next boundary" signal (the
 * auto-compaction path, which resumes without aborting), adopt that and
 * discard this extension.
 *
 * Limitation: `ctx.compact()` is wired only in interactive TUI mode. In
 * print / json / rpc modes it is a no-op, so `execute` returns "not available in
 * this mode" and schedules nothing — reporting a scheduling that never fires
 * would leave the agent believing context was freed.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

let pending = false;
let instructions: string | undefined;

const compactTool = defineTool({
	name: "compact",
	label: "Compact context",
	description:
		"Schedule session context compaction to run after the current turn finishes, " +
		"freeing context space for the next turn. Use this between subtasks or before " +
		"ingesting a large amount of new context, instead of waiting for automatic " +
		"threshold compaction to trigger.",
	parameters: Type.Object({
		instructions: Type.Optional(
			Type.String({
				description: "Optional focus instructions for the compaction summary",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		// `ctx.compact()` is wired only in interactive TUI mode; in rpc/json/print it is a no-op.
		// Scheduling anyway would report success for something that never runs, leaving the agent to
		// believe context was freed.
		if (ctx.mode !== "tui") {
			return {
				content: [
					{
						type: "text",
						text: `Compaction is not available in ${ctx.mode} mode (it is wired for interactive TUI only) — nothing was scheduled.`,
					},
				],
				details: { scheduled: false, reason: "mode" },
			};
		}
		pending = true;
		instructions = params.instructions;
		return {
			content: [
				{
					type: "text",
					text: "Compaction scheduled: it will run after the current turn completes and free context for the next turn.",
				},
			],
			details: { scheduled: true },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(compactTool);

	// Reset cross-session state so a stale request never leaks into a new session.
	pi.on("session_start", () => {
		pending = false;
		instructions = undefined;
	});

	// Fire the real compaction once the run has settled. `agent_end` listeners
	// still run as part of run settlement, so do NOT await here.
	pi.on("agent_end", (_event, ctx) => {
		if (!pending) return;
		pending = false;
		const focus = instructions;
		instructions = undefined;
		ctx.compact({ customInstructions: focus });
	});
}
