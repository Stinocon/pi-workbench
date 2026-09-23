/**
 * offload-rules.ts — Deterministic offload enforcement (harness-level rules).
 *
 * The model PROPOSES offload; this extension IMPOSES it where the trigger is
 * deterministically detectable. Two layers, with opposite error costs:
 *
 *   - BLOCK rules (phase 1): crisp signals. The only phase-1 BLOCK is
 *     `adversarial-review` — if a critical file was modified and no adversarial
 *     review by a DIFFERENT model ran, the task is not "done". Default is
 *     *report* (TUI notify); `pi --offload-enforce` feeds the review back to the
 *     agent, forcing it before the next "done".
 *   - MANDATE rules (config `directives`): injected into the system prompt as
 *     strong MUST-language. They cannot block, so a false positive is harmless;
 *     they are the phase-1 form of the fuzzy-signal rules (prose→structure).
 *
 * Rules live in ~/.pi/agent/offload-rules.json (deterministic, versioned), not
 * in the prompt: the model cannot reinterpret them, and the harness enforces
 * them regardless of what the model decides.
 *
 * No config / no matching rules = inert (mirrors verify-gates.ts).
 *
 * Known v1 limitation: "critical file modified" is detected only through the
 * `write`/`edit` tools. A `bash` command that edits a critical file (git apply,
 * heredoc, sed -i) is not detected deterministically and is out of scope.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AdversarialReviewRule {
  id: string;
  type: "block";
  criticalExtensions?: string[];
  reviewAgents?: string[];
  message?: string;
  maxReminders?: number;
}

interface OffloadConfig {
  rules?: AdversarialReviewRule[];
  directives?: string[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "offload-rules.json");
const MARKER = "<!-- pi-offload-rules -->";
const DEFAULT_CRITICAL = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh", ".bash", ".yaml", ".yml", ".json", ".sql", ".go", ".rs", ".tf", ".toml"];
const DEFAULT_REVIEW_AGENTS = ["miner-xhigh", "miner-max"];
const DEFAULT_MESSAGE =
  "Adversarial review required: critical files were modified but no review by a different model ran. " +
  'Run subagent(agent="miner-xhigh", task="adversarially review this change\'s diff") before declaring the task done.';

function loadConfig(): OffloadConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as OffloadConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isCriticalPath(p: string, exts: string[]): boolean {
  return exts.includes(extname(p).toLowerCase());
}

/** Extract the file path from a write/edit tool input (path | file_path | filePath). */
function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const p = rec.path ?? rec.file_path ?? rec.filePath;
  return typeof p === "string" ? p : undefined;
}

/** Collect the `agent` names from a subagent tool input (single / tasks / chain). */
function agentNames(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const names: string[] = [];
  if (typeof rec.agent === "string") names.push(rec.agent);
  for (const key of ["tasks", "chain"]) {
    const arr = rec[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object") {
          const agent = (item as Record<string, unknown>).agent;
          if (typeof agent === "string") names.push(agent);
        }
      }
    }
  }
  return names;
}

function matchesReview(agents: string[], reviewAgents: string[]): boolean {
  const lower = reviewAgents.map((a) => a.toLowerCase());
  return agents.some((a) => lower.some((r) => a.toLowerCase().includes(r)));
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const rule = (config.rules ?? []).find((r) => r.id === "adversarial-review" && r.type === "block");
  const directives = config.directives ?? [];
  if (!rule && directives.length === 0) return; // inert

  pi.registerFlag("offload-enforce", {
    type: "boolean",
    default: false,
    description:
      "Enforce deterministic offload rules: feed a mandatory adversarial review back to the agent when critical files changed without one (report-only by default).",
  });

  // --- System-prompt injection: active rules + standing mandates, every agent start. ---
  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(MARKER)) return;
    const lines: string[] = [];
    if (rule) {
      const exts = (rule.criticalExtensions ?? DEFAULT_CRITICAL).join(", ");
      const review = (rule.reviewAgents ?? DEFAULT_REVIEW_AGENTS)[0] ?? "miner-xhigh";
      lines.push(
        "1. adversarial-review (ENFORCED by the harness, not advisory): after you modify a critical file",
        `   (${exts}), an adversarial review by a DIFFERENT model must run before the task is done.`,
        `   Comply proactively: subagent(agent="${review}", task="adversarially review this diff").`,
        '   If you skip it and a critical file changed, the harness blocks the "done" claim.',
      );
    }
    if (directives.length > 0) {
      lines.push("2. standing offload mandates (MUST offload, do not do these inline):");
      for (const d of directives) lines.push(`   - ${d}`);
    }
    if (lines.length === 0) return;
    const block = `\n\n${MARKER}\n## Enforced offload rules (active — not advisory)\n\n${lines.join("\n")}\n`;
    return { systemPrompt: event.systemPrompt + block };
  });

  // --- Enforcement state (persists across agent runs within a session). ---
  let pendingReview = false;
  let reminders = 0;

  pi.on("session_start", () => {
    pendingReview = false;
    reminders = 0;
  });

  pi.on("tool_call", (event) => {
    if (!rule) return;
    const exts = (rule.criticalExtensions ?? DEFAULT_CRITICAL).map((e) => e.toLowerCase());
    const reviewAgents = rule.reviewAgents ?? DEFAULT_REVIEW_AGENTS;

    if (event.toolName === "write" || event.toolName === "edit") {
      const p = pathOf(event.input);
      if (p && isCriticalPath(p, exts)) pendingReview = true;
    } else if (event.toolName === "subagent") {
      if (matchesReview(agentNames(event.input), reviewAgents)) {
        pendingReview = false;
        reminders = 0; // review discharges the obligation; reset the reminder budget
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!rule || !pendingReview) return;
    const message = rule.message ?? DEFAULT_MESSAGE;

    if (!pi.getFlag("offload-enforce")) {
      ctx.ui.notify(`[offload-rules] ${message}`, "error");
      return;
    }

    const max = rule.maxReminders ?? 1;
    if (reminders >= max) {
      ctx.ui.notify(`[offload-rules] still unreviewed after ${reminders} reminder(s): ${message}`, "error");
      return;
    }
    reminders += 1;
    pi.sendUserMessage(
      `[offload-rules] ${message}\n\n` +
        'Run subagent(agent="miner-xhigh", task="adversarially review this change") now, or state explicitly why the review is waived.',
    );
  });
}
