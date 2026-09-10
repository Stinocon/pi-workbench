/**
 * Plan mode — pure utility functions (bash allowlist + plan extraction).
 * Extracted from the extension for testability.
 *
 * The bash allowlist is a best-effort read-only guardrail, NOT a security
 * sandbox: extensions run with full user permissions and a regex allowlist can
 * be bypassed by a determined model. It exists to catch accidental writes, not
 * to enforce a trust boundary.
 */

// --- Bash allowlist --------------------------------------------------------

// Commands that MUST be blocked even when they share a prefix with a safe one
// (e.g. `git remote add`, `curl -o`, `find -delete`). Tested over the WHOLE
// command string (not anchored), so any occurrence blocks the command.
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|rebuild|run)/i,
	/\byarn\s+(add|remove|install|publish|run)/i,
	/\bpnpm\s+(add|remove|install|publish|run)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade|reinstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|init|clone|clean|worktree)/i,
	/\bgit\s+branch\s+-[dD]/i,
	/\bgit\s+remote\s+(add|remove|rename|set-url|set-head|update|prune)/i,
	/\bfind\b[^\n]*-delete\b/i,
	/\bcurl\b[^\n]*(\s-O\b|\s-o\b|--output\b)/i,
	/\bwget\b[^\n]*(\s-O\s+(?!-)|--output-document\s+(?!-))/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Read-only commands allowed in plan mode. Anchored to the START of the command
// string, so only the first command in a pipeline is evaluated against this list
// (any destructive word anywhere still blocks via DESTRUCTIVE_PATTERNS above).
const SAFE_PATTERNS = [
	/^\s*cd\b/,
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|ls-|shortlog|describe|config\s+--(get|list))/i,
	/^\s*git\s+remote\s+(-v|--verbose)/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|why)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|view|info|outdated|audit|why)/i,
	/^\s*pip\s+(list|show|freeze|index)\b/i,
	/^\s*node\s+--version/i,
	/^\s*python3?\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
	/^\s*gh\s+(auth\s+status|issue\s+(list|view)|pr\s+(list|view|diff|status|checks)|repo\s+view|release\s+(list|view))/i,
];

export function isSafeCommand(command: string): boolean {
	const destructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	if (destructive) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}

// --- Plan extraction -------------------------------------------------------

export type DispatchTier = "low" | "medium" | "high" | "xhigh" | "max";

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
	/** Pre-classified dispatch effort tier, when the plan step carries a `[tier]` tag. */
	tier?: DispatchTier;
}

const TIER_TAG = /^\s*\[(low|medium|high|xhigh|max)\]\s*/i;

export function extractTier(text: string): DispatchTier | undefined {
	const m = text.match(TIER_TAG);
	return m ? (m[1].toLowerCase() as DispatchTier) : undefined;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(TIER_TAG, "")
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // bold/italic
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	// Capture the whole line after the number, so inline **bold** or `code`
	// inside a step does not truncate it (the reference's [^*\n]+ does).
	const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = match[2].trim();
		if (raw.length > 5 && !raw.startsWith("`") && !raw.startsWith("/") && !raw.startsWith("-")) {
			const tier = extractTier(raw);
			const cleaned = cleanStepText(raw);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false, tier });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
