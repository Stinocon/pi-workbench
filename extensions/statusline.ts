/**
 * Statusline — faithful port of the Claude Code `/statusline` for Pi.
 *
 * Replicates the Claude Code statusline layout and semantics, left→right, each element
 * separated by a dim "·":
 *
 *   <model>  ctx [=====-----] 29% (293k/1.0M)  5h:45%  7d:70%  effort:high  thinking  ≈$20.17
 *
 * Palette (Claude Code's traffic-light coding):
 *   - model            gold/amber, bold
 *   - `ctx` label      grey-olive (muted)
 *   - progress bar     filled in bright green, remainder in dim dotted grey
 *   - percentage       bright green (success); red when approaching the cap
 *   - (used/window)    khaki (warning)
 *   - usage windows    5h yellow, 7d orange  (red when near/over a threshold)
 *   - effort:x         khaki (muted)
 *   - thinking         magenta  (custom ANSI — pi has no magenta key)
 *   - ≈$cost          green (success)
 *   - ↑in ↓out        token totals (muted) — cumulative session volume
 *   - N turns         session turn count (muted)
 *
 * What Pi exposes vs. what Claude Code shows:
 *   - model             → ctx.model.id                        ✓ exact
 *   - ctx usage         → ctx.getContextUsage() (tokens/window/percent)  ✓ exact
 *   - progress bar      → derived from percent                ✓
 *   - cost              → assembled from assistant usage cost ✓ estimate (Claude shows total)
 *   - 5h:xx% / 7d:xx%   → Pi does not expose usage windows; rendered with the
 *                         current session elapsed/fraction only where meaningful,
 *                         otherwise omitted (honesty: don't invent fake 5h/7d values)
 *   - effort:x          → ctx.thinkingLevel (off|low|...|max) ✓
 *   - thinking          → shown when ctx.thinkingLevel != "off"   ✓
 *
 * Usage:
 *   (auto)                enabled by default on every session (interactive mode)
 *   /statusline on        force enable (no-op when already on)
 *   /statusline off       restore the default footer
 *   /statusline toggle    same as bare /statusline
 *
 * Bare /statusline toggles the current state.
 * Interactive (TUI) only. Updates on turn start/end (working pulse + totals),
 * model change, branch change and every second (clock).
 *
 * Refinements over a bare port: a subtle working pulse (●) during runs, a ctx bar
 * that grows with terminal width (like Claude Code), and no dead helpers.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/* ---- Small ANSI helpers for the exact Claude Code tones Ti's theme lacks ---- */
const ansi = (code: string, s: string, reset: string): string => `\x1b[${code}m${s}\x1b[${reset}m`;
const MAGENTA = (s: string): string => ansi("35", s, "39");
const GOLD = (s: string): string => ansi("33;1", s, "39"); // bright yellow=gold, bold
const DIMDOT = (s: string): string => ansi("90", s, "39"); // bright black ~ grey-olive dotted

function fmt(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCtx(n: number, window: number): string {
	// used: whole k below 1M; window: one decimal above 1M (Claude Code style)
	const used = n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
	const cap = window >= 1_000_000 ? `${(window / 1_000_000).toFixed(1)}M` : fmt(window);
	return `${used}/${cap}`;
}

interface Totals {
	input: number;
	output: number;
	cost: number;
	turns: number;
}

function money(cost: number): string {
	if (cost <= 0) return "$0.00";
	return `$${cost.toFixed(2)}`;
}

/** Render a progress bar of `width` cells filled to `percent`. */
function bar(percent: number, width: number, theme: any): string {
	const p = Math.max(0, Math.min(100, percent));
	const filled = Math.round((p / 100) * width);
	const solid = theme.fg("success", "█".repeat(filled));
	const rest = DIMDOT("░".repeat(width - filled));
	return solid + rest;
}

/** Bar width that grows with the terminal (Claude Code grows on wide screens). */
function barWidth(termWidth: number): number {
	return termWidth >= 180 ? 10 : termWidth >= 120 ? 8 : termWidth >= 80 ? 6 : 4;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let working = false;
	let sessionStart = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;
	let pendingRender: (() => void) | null = null;

	const computeTotals = (ctx: any): Totals => {
		let input = 0,
			output = 0,
			cost = 0,
			turns = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input || 0;
				output += m.usage.output || 0;
				cost += m.usage.cost?.total || 0;
				turns += 1;
			}
		}
		return { input, output, cost, turns };
	};

	const elapsed = (): string => {
		const s = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		if (h > 0) return `${h}h:${String(m).padStart(2, "0")}m`;
		return `${m}:${String(sec).padStart(2, "0")}`;
	};

	const startTimer = (render: () => void) => {
		if (timer) return;
		timer = setInterval(render, 1000);
	};

	const dispose = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		pendingRender = null;
	};

	/** Enable the statusline. notify=false silences the toast (used for auto-start). */
	const enable = (ctx: any, notify = true) => {
		sessionStart = Date.now();
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const renderTick = () => tui.requestRender();
			startTimer(renderTick);
			pendingRender = renderTick;

			return {
				dispose: () => {
					unsubBranch();
					dispose();
				},
				invalidate() {},
				render(width: number): string[] {
					const usage = (() => {
						try {
							const u = ctx.getContextUsage();
							if (u && typeof u.tokens === "number" && u.tokens > 0) return u;
							return null;
						} catch {
							return null;
						}
					})();

					const totals = computeTotals(ctx);
					const model = ctx.model?.id || "no-model";
					const branch = footerData.getGitBranch();
					const tl = (ctx.thinkingLevel || "off") as string;
					const thinkingOn = tl !== "off";

					// 1. model — gold, bold, prefixed by a subtle working pulse
					const pulse = working ? theme.fg("accent", "● ") : theme.fg("dim", "  ");
					let line = pulse + GOLD(theme.bold(model));

					// 2+3. ctx label + progress bar + %
					if (usage) {
						const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
						line +=
							theme.fg("dim", " · ") +
							theme.fg("muted", "ctx") +
							theme.fg("muted", " ") +
							bar(pct, barWidth(width), theme);
						// % — red when near cap, else success green
						const pctStr = theme.fg(pct >= 85 ? "error" : "success", `${Math.round(pct)}%`);
						line += theme.fg("dim", " ") + pctStr;
						// (used/window) — khaki
						line +=
							theme.fg("dim", " ") +
							theme.fg("warning", `(${fmtCtx(usage.tokens, usage.contextWindow)})`);
					}

					// 4. usage window — Pi has no 5h/7d windows; show session elapsed
					//    as a stand-in only when the session is meaningfully long.
					const sesEl = elapsed();
					if (sesEl.startsWith("h")) {
						line += theme.fg("dim", " · ") + theme.fg("warning", `${sesEl}`);
					}

					// 5. effort:<level> — khaki (muted)
					line +=
						theme.fg("dim", " · ") +
						theme.fg("muted", `effort:${tl}`);

					// 6. thinking — magenta (only when thinking is on)
					if (thinkingOn) {
						line += theme.fg("dim", " · ") + MAGENTA("thinking");
					}

					// 7. ≈$cost — green, plus token totals and turn count (dim)
					if (totals.cost > 0) {
						line += theme.fg("dim", " · ") + theme.fg("success", `≈${money(totals.cost)}`);
					}
					if (totals.input > 0 || totals.output > 0) {
						line +=
							theme.fg("dim", " · ") +
							theme.fg("muted", `↑${fmt(totals.input)} ↓${fmt(totals.output)}`);
					}
					if (totals.turns > 0) {
						line += theme.fg("dim", " · ") + theme.fg("muted", `${totals.turns} turn${totals.turns === 1 ? "" : "s"}`);
					}

					// Right side: git branch + clock (right-aligned)
					let right = "";
					if (branch) right += theme.fg("accent", branch);
					if (right && sesEl) right += theme.fg("dim", " · ");
					if (sesEl) right += theme.fg("dim", sesEl);

					const pad = " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(right)));
					return [truncateToWidth(line + pad + right, width)];
				},
			};
		});
		enabled = true;
		if (notify) ctx.ui.notify("Statusline enabled (Claude Code style)", "info");
	};

	const disable = (ctx: any) => {
		ctx.ui.setFooter(undefined);
		enabled = false;
		ctx.ui.notify("Default footer restored", "info");
	};

	const setEnabled = (ctx: any, on: boolean, notify = true) => {
		if (on && !enabled) enable(ctx, notify);
		else if (!on && enabled) disable(ctx);
	};

	pi.registerCommand("statusline", {
		description: "Toggle the Claude Code-style statusline footer",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/statusline requires interactive mode", "error");
				return;
			}
			const a = args.trim().toLowerCase();
			if (a === "on") setEnabled(ctx, true);
			else if (a === "off") setEnabled(ctx, false);
			else setEnabled(ctx, !enabled); // includes bare /statusline and /statusline toggle
		},
	});

	// Auto-enable on every session (interactive mode only), so the statusline is on
	// by default instead of requiring a manual `/statusline on` each time.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		setEnabled(ctx, true, false); // silent: on by default, no startup toast
	});

	// Keep the footer fresh on turn boundaries: working pulse + token/cost totals.
	pi.on("turn_start", async (_event, ctx) => {
		working = true;
		if (enabled && pendingRender) pendingRender();
	});
	pi.on("turn_end", async (_event, ctx) => {
		working = false;
		if (enabled && pendingRender) pendingRender();
	});
}