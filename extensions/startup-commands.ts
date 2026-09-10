/**
 * startup-commands — a login-style "MOTD": on Pi startup, show the custom slash commands
 * with a one-line explanation each, as a widget above the editor. Cleared as soon as the
 * user submits their first prompt (or the session ends). The list is enumerated from
 * pi.getCommands() — single source of truth, so it can never drift from what is actually
 * registered when commands are added or removed. Only the user's own workflow commands
 * are shown: package/builtin operator commands (/mcp:*, /opencode-*, /llama) and TUI
 * toggles (/statusline) are filtered out — they are infrastructure, not workflow, and
 * would only eat vertical space above the editor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "startup-commands";
const MAX_DESC = 70;

/** Take the description's core (drop a trailing "(...) detail") and cap it to one line. */
function brief(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	const cut = t.indexOf(" (");
	const core = cut > 0 ? t.slice(0, cut) : t;
	return core.length > MAX_DESC ? `${core.slice(0, MAX_DESC - 1)}…` : core;
}

export default function (pi: ExtensionAPI): void {
	let shown = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || ctx.mode !== "tui") return;

		// Operator commands (MCP server control, provider auth, llama router, TUI toggles)
		// are infrastructure, not workflow; surfacing them in the MOTD is noise. Package
		// commands (sourceInfo.origin "package": /mcp:*, /opencode-*) and inline built-ins
		// (path "<...>": /llama) are excluded via sourceInfo; /statusline is a TUI toggle.
		const OPERATOR_ONLY = new Set(["statusline"]);
		const cmds = pi
			.getCommands()
			.filter((c) => c.source === "extension")
			.filter((c) => c.sourceInfo.origin !== "package" && !c.sourceInfo.path.startsWith("<"))
			.filter((c) => !OPERATOR_ONLY.has(c.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (cmds.length === 0) return;

		const lines = ["Custom commands"];
		for (const c of cmds) {
			lines.push(`  /${c.name} — ${brief(c.description ?? "")}`);
		}
		lines.push("  /skill:<name> — force-load a skill (e.g. /skill:council)");
		ctx.ui.setWidget(WIDGET_KEY, lines);
		shown = true;
	});

	// Clear the banner as soon as the user starts working.
	pi.on("input", async (_event, ctx) => {
		if (shown) {
			shown = false;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (shown) {
			shown = false;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
