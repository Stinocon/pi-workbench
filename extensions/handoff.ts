/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 *
 * The `handoff` TOOL lets the agent draft a handoff prompt itself (non-disruptive: it only
 * fills the editor, never creates the session).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile, access } from "node:fs/promises";
import * as path from "node:path";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

/** Generate the handoff prompt from the conversation and the goal. Returns "" if no model/messages/aborted. */
async function generateHandoffPrompt(
	goal: string,
	messages: AgentMessage[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	if (!ctx.model || messages.length === 0) return "";
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const userMessage: Message = {
		role: "user",
		content: [
			{ type: "text", text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}` },
		],
		timestamp: Date.now(),
	};
	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ signal, cacheRetention: "none", sessionId: uuidv7() },
	);
	if (response.stopReason === "aborted") return "";
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			// Gather conversation context from current branch. If the branch was compacted,
			// include the compaction summary plus entries from firstKeptEntryId onward.
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Generate the handoff prompt with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
				loader.onAbort = () => done(null);

				generateHandoffPrompt(goal, messages, ctx, loader.signal)
					.then((prompt) => done(prompt || null))
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Let user edit the generated prompt
			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Save the handoff as a durable plaintext artifact (not versioned: .pi/memory/).
			try {
				const dir = path.join(ctx.cwd, ".pi", "memory");
				await mkdir(dir, { recursive: true });
				const gi = path.join(dir, ".gitignore");
				try {
					await access(gi);
				} catch {
					await writeFile(gi, "*\n", "utf8");
				}
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				await writeFile(path.join(dir, `handoff-${ts}.md`), editedPrompt, "utf8");
			} catch {
				/* best-effort: the new session is the primary handoff path */
			}

			// Create new session with parent tracking. Use the replacement-session
			// context for post-switch UI work; the original ctx is stale after a
			// successful session replacement.
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});

	// Model-callable: draft a handoff prompt (non-disruptive — it only fills the editor).
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description: "Generate a self-contained context-transfer prompt for a new focused session and draft it into the editor for review. Use when the session is long or fragmented and a fresh session with a focused prompt would serve better than grinding on. It does NOT create the session — you review and submit the drafted prompt.",
		parameters: Type.Object({
			goal: Type.String({ description: "Goal for the new session" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return { content: [{ type: "text", text: "handoff requires an interactive (TUI) session." }], details: {} };
			}
			const goal = String(params.goal).trim();
			if (!goal) {
				return { content: [{ type: "text", text: "handoff requires a goal." }], details: {} };
			}
			try {
				const messages = getHandoffMessages(ctx.sessionManager.getBranch());
				if (messages.length === 0) {
					return { content: [{ type: "text", text: "No conversation to hand off." }], details: {} };
				}
				const prompt = await generateHandoffPrompt(goal, messages, ctx, signal);
				if (!prompt.trim()) {
					return { content: [{ type: "text", text: "Could not generate a handoff prompt (no model or aborted)." }], details: {} };
				}
				ctx.ui.setEditorText(prompt);
				ctx.ui.notify("Handoff prompt drafted — review and submit.", "info");
				return { content: [{ type: "text", text: "Handoff prompt drafted into the editor. Review and submit it to start the new session." }], details: {} };
			} catch (err) {
				return { content: [{ type: "text", text: `handoff failed: ${(err as Error).message}` }], details: {} };
			}
		},
	});
}
