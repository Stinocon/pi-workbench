/**
 * delegate.ts — bounded worker offload (cloud-first routing).
 *
 * Registers the `delegate` tool. The CLOUD PRIMARY agent is the reasoning authority; it
 * offloads ONE bounded, mechanically-verifiable subtask to a worker model and receives the
 * result inline, then validates and continues. The default target is the configured DRAFT
 * worker (a cheap, fast model) for prose→structure and small self-contained code drafts; the
 * configured LOCAL worker is the offline fallback; a stronger cloud model is available only
 * for a rare, justified escalation.
 *
 * Workers are declared in `~/.pi/agent/workers.json` (see `workers.example.json`). No provider
 * or model is hardcoded: the draft tier, the local fallback and the cloud provider are all
 * user configuration, so the same mechanism runs on any provider.
 *
 * The worker is isolated and data-minimized: it receives only the brief (never the primary
 * conversation, repository, or MCP state), returns a text answer, and the primary keeps all
 * decision authority. Reuses the proven sub-agent spawn primitive
 * (`pi --mode json -p --no-session --model … --tools …`) established by `subagent` /
 * `session-memory`, with strict validation, tiered secret screening, and a pre-send size report.
 *
 * This file lives in ~/.pi/agent/extensions/ and is auto-discovered by Pi. It does not modify
 * any existing config.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Worker configuration (user-owned, provider-agnostic)
// ---------------------------------------------------------------------------

const WORKERS_PATH = path.join(homedir(), ".pi", "agent", "workers.json");

const DRAFT_ALIAS = "draft";
const LOCAL_ALIAS = "local";

interface WorkerConfig {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  costIn?: number | null;
  costOut?: number | null;
}

interface WorkersConfig {
  draft?: WorkerConfig | null;
  local?: WorkerConfig | null;
  cloudProvider?: string | null;
}

/** Read the user's worker declaration; absent sections are simply unavailable. */
function readWorkers(): WorkersConfig {
  try {
    const raw = fs.readFileSync(WORKERS_PATH, "utf-8");
    const data = JSON.parse(raw);
    const w: WorkersConfig = {};
    if (data && typeof data === "object") {
      w.draft = readWorker(data.draft);
      w.local = readWorker(data.local);
      w.cloudProvider = typeof data.cloudProvider === "string" && data.cloudProvider.trim()
        ? data.cloudProvider.trim()
        : null;
    }
    return w;
  } catch {
    return {};
  }
}

function readWorker(v: unknown): WorkerConfig | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const provider = typeof o.provider === "string" ? o.provider.trim() : "";
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (!provider || !model) return null;
  return {
    provider,
    model,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : model,
    contextWindow: typeof o.contextWindow === "number" ? o.contextWindow : undefined,
    maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : undefined,
    costIn: typeof o.costIn === "number" ? o.costIn : null,
    costOut: typeof o.costOut === "number" ? o.costOut : null,
  };
}

/** Local-only audit log of every delegated brief (post-screening, so secrets never reach disk). */
const AUDIT_LOG = path.join(homedir(), ".pi", "agent", ".delegate-audit.log");

/** Read-only tool set the delegated model may be granted (never bash/edit/write). */
const READ_ONLY_TOOLS = "read,ls,find,grep,glob";

/** Default maximum brief size before we refuse to send (chars). ~40K chars ≈ ~10K tokens. */
const DEFAULT_MAX_BRIEF_CHARS = 40_000;
const DEFAULT_TIMEOUT_SECONDS = 600;

// ---------------------------------------------------------------------------
// Target listing
// ---------------------------------------------------------------------------

function formatCatalog(cfg: WorkersConfig): string {
  const lines: string[] = [
    "Worker targets for `delegate` (offload ONE bounded subtask):",
    "",
  ];
  if (cfg.draft) {
    const d = cfg.draft;
    const ctx = d.contextWindow ? `${(d.contextWindow / 1024).toFixed(0)}K ctx` : "";
    const cost = d.costIn != null ? `$${d.costIn}/$${d.costOut}` : "cost n/a";
    lines.push(`- \`${DRAFT_ALIAS}\` → DRAFT worker (\`${d.provider}/${d.model}\`)${ctx ? ` · ${ctx}` : ""}${d.costIn != null ? ` · ${cost}` : ""} — cheap/fast tier for prose → structure + small self-contained code drafts; output ALWAYS reviewed by the primary.`);
  } else {
    lines.push(`- \`${DRAFT_ALIAS}\` — NOT configured. Add a \`draft\` entry to \`~/.pi/agent/workers.json\` (see \`workers.example.json\`).`);
  }
  lines.push("");
  if (cfg.local) {
    const l = cfg.local;
    lines.push(`- \`${LOCAL_ALIAS}\` → LOCAL worker (\`${l.provider}/${l.model}\`) — offline fallback ONLY (prose → structured table/summary, and only when faster than doing it by hand). Isolated and tool-free.`);
  } else {
    lines.push(`- \`${LOCAL_ALIAS}\` — NOT configured. Add a \`local\` entry to \`~/.pi/agent/workers.json\`.`);
  }
  lines.push("");
  lines.push("Cloud escalation: pass any concrete `provider/model` id from your provider (run `pi --list-models`) for a rare, justified escalation to a stronger model.");
  if (cfg.cloudProvider) {
    lines.push(`(A bare cloud id is resolved against the configured provider \`${cfg.cloudProvider}\`.)`);
  } else {
    lines.push("(Set `cloudProvider` in workers.json to resolve bare cloud ids.)");
  }
  return lines.join("\n");
}

interface ResolvedTarget {
  kind: "draft" | "local" | "cloud";
  provider: string;
  id: string;
  name: string;
}

/** Resolve a model argument to a concrete worker target (draft, local, or a cloud model). */
function resolveTarget(modelRaw: string, cfg: WorkersConfig): ResolvedTarget | null {
  const raw = modelRaw.trim();
  if (!raw) return null;
  const l = raw.toLowerCase();

  if (cfg.draft && (l === DRAFT_ALIAS || l === cfg.draft.model.toLowerCase())) {
    return { kind: "draft", provider: cfg.draft.provider, id: cfg.draft.model, name: cfg.draft.name };
  }
  if (cfg.local && (l === LOCAL_ALIAS || l === cfg.local.model.toLowerCase())) {
    return { kind: "local", provider: cfg.local.provider, id: cfg.local.model, name: cfg.local.name };
  }
  if (l === DRAFT_ALIAS || l === LOCAL_ALIAS) {
    return null; // alias requested but not configured → handled by the caller
  }

  // Cloud: accept "provider/model"; a bare id resolves against the configured cloud provider.
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const provider = raw.slice(0, slash).trim();
    const id = raw.slice(slash + 1).trim();
    if (provider && id) return { kind: "cloud", provider, id, name: id };
    return null;
  }
  if (cfg.cloudProvider) {
    return { kind: "cloud", provider: cfg.cloudProvider, id: raw, name: raw };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secret screening — conservative, tiered, honest. Not a guarantee; the local
// model controls what it puts in the brief (data minimization is by construction).
// ---------------------------------------------------------------------------

interface ScreenResult {
  refused: boolean;
  reason: string | null; // only set when refused
  redacted: string; // brief with probable-sensitive spans masked
  redactionCount: number;
}

/** Clearly-definite secrets: refuse the whole delegation. */
const DEFINITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { name: "password assignment", re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
  { name: "secret/token/key assignment", re: /\b(?:secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token)\s*[:=]\s*\S+/i },
  { name: "authorization header", re: /authorization\s*:\s*(?:bearer|basic)\s+\S+/i },
  { name: "credential in URL", re: /(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s/:]+:[^@\s/]+@/i },
];

/** Probably-sensitive (looks like a token but could be a hash/id): redact, do not refuse.
 *  Deliberately conservative to avoid false positives on ordinary code: identifiers with
 *  underscores, readable words, and numeric constants are excluded by `isDenseSecretLike`. */
const PROBABLE_PATTERNS: { name: string; re: RegExp }[] = [
  // JSON Web Token (compact three-segment base64url form; header typically starts "eyJ").
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Dense token-like strings: no underscores, high character variety. Gate in isDenseSecretLike.
  { name: "dense token", re: /\b[A-Za-z0-9+/=]{24,}\b/g },
  // Private-URL token pattern (e.g. /private_<hex-ish> in a service URL).
  { name: "private URL token", re: /\/private_[A-Za-z0-9_-]+/g },
];

function isDenseSecretLike(s: string): boolean {
  // Code identifiers use underscores and readable words; real tokens are dense and
  // character-varied. Reject anything that looks like an identifier, a repeated pattern, or a
  // path: `/` is the path separator (also in the base64 alphabet) and was matching absolute
  // paths like /Users/.../github.com/..., redacting them and breaking `allowRead`.
  if (s.includes("_")) return false;
  if (s.includes("/")) return false;
  const unique = new Set(s).size;
  if (unique < 10) return false;
  if (unique / s.length < 0.5) return false; // too repetitive (e.g. "aaaaaaaa...")
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  const classes = [hasUpper, hasLower, hasDigit].filter(Boolean).length;
  return classes >= 2;
}

function auditLog(entry: string): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    fs.appendFileSync(AUDIT_LOG, entry, { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(AUDIT_LOG, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort: audit logging must never break delegation */ }
}

function screenBrief(brief: string): ScreenResult {
  for (const p of DEFINITE_PATTERNS) {
    if (p.re.test(brief)) {
      return {
        refused: true,
        reason: `refused: brief contains ${p.name} (definitely sensitive). Redact it and retry.`,
        redacted: brief,
        redactionCount: 0,
      };
    }
  }

  let redacted = brief;
  let redactionCount = 0;
  for (const p of PROBABLE_PATTERNS) {
    redacted = redacted.replace(p.re, (match) => {
      // The dense-token pattern also catches readable text; only redact genuinely dense spans.
      if (p.name === "dense token" && !isDenseSecretLike(match)) return match;
      redactionCount += 1;
      return `<REDACTED:${p.name}>`;
    });
  }
  return { refused: false, reason: null, redacted, redactionCount };
}

// ---------------------------------------------------------------------------
// Brief construction — only the caller's explicit fields reach the cloud model
// ---------------------------------------------------------------------------

function buildBrief(params: {
  objective: string;
  context?: string;
  files?: { path: string; excerpt: string }[];
  constraints?: string[];
  expectedOutput?: string;
  allowRead?: boolean;
}): string {
  const sections: string[] = [];

  sections.push(
    "You are a bounded worker sub-agent invoked by a primary agent to perform ONE bounded subtask.",
    "Do exactly what the objective asks; do not expand scope and do not make decisions beyond it.",
    "",
    `You are ${params.allowRead ? "READ-ONLY" : "tool-free"}: you must not modify files, ` +
      "run commands, or make any changes to the user's system. Analyze and answer only.",
    "",
  );

  sections.push("## Objective", params.objective, "");

  if (params.context && params.context.trim()) {
    sections.push("## Background / findings", params.context.trim(), "");
  }

  if (params.files && params.files.length > 0) {
    sections.push("## Relevant file excerpts");
    for (const f of params.files) {
      sections.push(`### ${f.path}`, "```", f.excerpt, "```", "");
    }
  }

  if (params.constraints && params.constraints.length > 0) {
    sections.push("## Constraints", ...params.constraints.map((c) => `- ${c}`), "");
  }

  sections.push(
    "## Boundary",
    "Do not make decisions beyond the objective and do not expand the task. If the requested output cannot be produced from the provided context, say so explicitly instead of guessing.",
    "",
  );

  sections.push(
    "## Expected output",
    (params.expectedOutput && params.expectedOutput.trim()) ||
      "The precise requested result, with no preamble. If information is missing, state that explicitly.",
    "",
    "Return your final answer directly — no preamble, no meta-commentary.",
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Sub-agent execution (reuses the pi --mode json spawn primitive)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function extractFinalAssistantText(stdout: string): { text: string; model: string | null } {
  let last = "";
  let model: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      if (ev.message.model) model = String(ev.message.model);
      const content = ev.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text.trim()) last = text;
      }
    }
  }
  return { text: last.trim(), model };
}

interface DelegateOutcome {
  ok: boolean;
  output: string;
  error: string | null;
  stderr: string;
  durationMs: number;
  actualModel: string | null;
}

function runWorker(
  cwd: string,
  modelRef: string,
  thinking: string,
  allowRead: boolean,
  brief: string,
  timeoutSeconds: number,
): Promise<DelegateOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let tmpDir: string | null = null;
    let tmpPath: string | null = null;
    let settled = false;

    const finish = (outcome: DelegateOutcome) => {
      if (settled) return;
      settled = true;
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
      resolve(outcome);
    };

    const args = ["--mode", "json", "-p", "--no-session", "--model", modelRef];
    if (thinking) args.push("--thinking", thinking);
    // Data minimization: no skills, no AGENTS.md/CLAUDE.md, fresh isolated session.
    args.push("--no-skills", "--no-context-files");
    if (allowRead) args.push("--tools", READ_ONLY_TOOLS);
    else args.push("--no-tools");

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delegate-"));
      tmpPath = path.join(tmpDir, "brief.md");
      fs.writeFileSync(tmpPath, brief, { encoding: "utf-8", mode: 0o600 });
      args.push("--append-system-prompt", tmpPath);
    } catch (err) {
      finish({ ok: false, output: "", error: `could not stage brief: ${(err as Error).message}`, stderr: "", durationMs: Date.now() - started, actualModel: null });
      return;
    }

    args.push("Solve the delegated subtask described in your system instructions. Return your final answer directly.");

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      // SIGKILL incondizionato: kill() su un processo già uscito è un no-op (ritorna false),
      // mentre `proc.killed` è già true dopo la SIGTERM, quindi un guard `if (!proc.killed)`
      // non farebbe mai partire il fallback.
      setTimeout(() => { proc.kill("SIGKILL"); }, 5000).unref?.();
    }, timeoutSeconds * 1000);
    timer.unref?.();

    proc.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, output: "", error: `failed to spawn pi: ${e.message}`, stderr: err, durationMs: Date.now() - started, actualModel: null });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const parsed = extractFinalAssistantText(out);
      if (code === 0 && parsed.text) {
        finish({ ok: true, output: parsed.text, error: null, stderr: err, durationMs: Date.now() - started, actualModel: parsed.model });
      } else if (code === 0 && !parsed.text) {
        finish({ ok: false, output: "", error: "delegation returned no usable output", stderr: err, durationMs: Date.now() - started, actualModel: parsed.model });
      } else if (code === null) {
        finish({ ok: false, output: "", error: `delegation timed out after ${timeoutSeconds}s`, stderr: err, durationMs: Date.now() - started, actualModel: parsed.model });
      } else {
        finish({ ok: false, output: "", error: mapExitError(code, err), stderr: err, durationMs: Date.now() - started, actualModel: parsed.model });
      }
    });
  });
}

function mapExitError(code: number, stderr: string): string {
  const s = stderr.toLowerCase();
  const hay = stderr + " " + s;
  if (hay.includes("connection refused") || hay.includes("econnrefused") || hay.includes("econnreset") || hay.includes("127.0.0.1")) {
    return "the local worker is unavailable (server down or unreachable). Do the task yourself on the cloud primary — do not retry the local worker.";
  }
  if (hay.includes("no models match") || hay.includes("unknown model") || hay.includes("model not found")) {
    return "the requested model was not found (list targets via delegate with no model).";
  }
  if (hay.includes("401") || hay.includes("unauthorized") || hay.includes("authentication")) {
    return "model authentication failed (missing/invalid key).";
  }
  if (hay.includes("402") || hay.includes("payment required") || hay.includes("no credits") || hay.includes("insufficient")) {
    return "the draft worker's credit is exhausted or the plan is not paying (402). Do this task inline on the cloud primary.";
  }
  if (hay.includes("403") || hay.includes("forbidden")) {
    return "the provider rejected the request (403). Check the plan/entitlement.";
  }
  if (hay.includes("429") || hay.includes("rate limit")) {
    return "the provider rate-limited the request (429). Retry later or do the task yourself.";
  }
  if (hay.includes("timeout") || hay.includes("timed out")) {
    return "the worker request timed out.";
  }
  return `delegation failed (exit ${code}): ${stderr.slice(-300) || "no stderr"}`;
}

// ---------------------------------------------------------------------------
// Tool parameters + registration
// ---------------------------------------------------------------------------

const FileExcerpt = Type.Object(
  {
    path: Type.String({ description: "Path of the file (for reference only)." }),
    excerpt: Type.String({ description: "The specific excerpt/region relevant to the subtask. Keep it small." }),
  },
  { description: "A single file reference with exactly two string fields: `path` and `excerpt`." },
);

const DelegateParams = Type.Object({
  model: Type.Optional(Type.String({
    description: "Worker target: `draft` for the configured draft worker (cheap/fast — prose→structure + small code drafts), `local` for the configured local offline fallback, or a concrete `provider/model` cloud id (e.g. `<your-provider>/<your-model>`) for a rare, justified escalation. NOT a dispatch tier or miner-* name. Omit (or `list`) to list targets.",
  })),
  objective: Type.Optional(Type.String({
    description: "Required when offloading: the single bounded, mechanically-verifiable task, in one or two sentences.",
  })),
  context: Type.Optional(Type.String({
    description: "Concise background/data the worker needs. Only what is relevant (data minimization).",
  })),
  files: Type.Optional(Type.Array(FileExcerpt, {
    description: "Array of objects, each with exactly two string fields: `path` and `excerpt`. Example: [{path: 'src/example.py', excerpt: 'the relevant lines only'}]. Send only the excerpts that matter, kept small.",
  })),
  constraints: Type.Optional(Type.Array(Type.String(), {
    description: "Hard constraints AND what the worker must NOT decide (e.g. 'do not modify anything', 'do not infer entities not present').",
  })),
  expectedOutput: Type.Optional(Type.String({
    description: "The exact shape of the expected result (e.g. 'a deduplicated list of entity_ids').",
  })),
  thinking: Type.Optional(Type.String({
    description: "Thinking level for the worker: off/minimal/low/medium/high/xhigh/max. Default: minimal for the local worker, high for cloud.",
  })),
  allowRead: Type.Optional(Type.Boolean({
    description: "Grant the worker read-only file tools (read/ls/find/grep/glob). Default false (tool-free, isolated).",
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    description: "Timeout in seconds. Default 600.",
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate to worker",
    description: [
      "Offload ONE bounded, mechanically-verifiable subtask to a worker and return its result inline for you (the cloud primary) to validate.",
      "Default worker is the configured draft tier (model `draft` — a cheap, fast model declared in ~/.pi/agent/workers.json) for prose → structured table/summary and small self-contained code drafts; the configured local worker (`local`) is the offline fallback. Route what to delegate by the routing policy in your system prompt: deterministic extraction/enumeration → grep/awk (never an LLM); keep analytical, security, smart-home/infrastructure writes, and complex/ambiguous work on CLOUD.",
      "The worker is isolated and data-minimized: it receives only the brief you pass (never your conversation, repo, MCP state, or credentials), is tool-free by default (read-only file tools only with allowRead: true), and cannot modify anything. Never trust its result blindly — verify against source, then synthesize yourself; on worker failure do the task yourself (0–1 retries).",
      "Omit `model` (or pass 'list') to list worker targets. `model` is a concrete id ('draft', 'local', or a 'provider/model' cloud id) — dispatch tiers (low…max) and miner-* names are NOT valid.",
      "Example: delegate({model: 'draft', objective: 'Convert this troubleshooting doc into a symptom/cause/fix table', files: [{path: 'TROUBLESHOOTING.md', excerpt: '…'}], constraints: ['do not modify anything', 'do not invent entries not in the doc'], expectedOutput: 'a markdown table with one row per problem'})",
    ].join(" "),
    promptSnippet: "delegate — offload ONE bounded, verifiable subtask to the draft worker (or the local fallback / a cloud model); result returns inline for validation.",
    promptGuidelines: [
      "delegate files = an array of {path, excerpt} objects (e.g. [{path: 'src/x.py', excerpt: '…'}]). Send only the minimum relevant context — the worker receives only your brief, never the conversation, repo, MCP state, or credentials.",
    ],
    parameters: DelegateParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cfg = readWorkers();

      // List mode
      const modelRaw = (params.model ?? "").trim();
      if (!modelRaw || modelRaw.toLowerCase() === "list") {
        return {
          content: [{ type: "text", text: formatCatalog(cfg) }],
          details: { mode: "list", draftConfigured: !!cfg.draft, localConfigured: !!cfg.local, cloudProvider: cfg.cloudProvider ?? null },
        };
      }

      // Resolve the worker target (draft, local, or a concrete cloud model)
      const target = resolveTarget(modelRaw, cfg);
      if (!target) {
        const alias = modelRaw.toLowerCase();
        const aliasUnconfigured = alias === DRAFT_ALIAS || alias === LOCAL_ALIAS;
        const hint = aliasUnconfigured
          ? `The \`${alias}\` worker is not configured. Create \`~/.pi/agent/workers.json\` with a \`${alias}\` entry (see \`workers.example.json\`).`
          : "Pass a concrete `provider/model` id (run `pi --list-models`), or set `cloudProvider` in workers.json to resolve bare ids.";
        const available = [
          cfg.draft ? `\`${DRAFT_ALIAS}\` (draft worker)` : null,
          cfg.local ? `\`${LOCAL_ALIAS}\` (local worker)` : null,
          "`provider/model` cloud id",
        ].filter(Boolean).join(", ");
        return {
          content: [{
            type: "text",
            text: `Unknown worker model "${modelRaw}". Available: ${available}.\n\n${hint}\n\n(Omit \`model\` to list worker targets with descriptions.)`,
          }],
          details: { mode: "delegate", model: modelRaw },
          isError: true,
        };
      }

      const objective = (params.objective ?? "").trim();
      if (!objective) {
        return {
          content: [{ type: "text", text: "Delegation requires an `objective` (the bounded subtask to solve)." }],
          details: { mode: "delegate", model: target.id, target: target.kind },
          isError: true,
        };
      }

      const files = params.files ?? [];
      const brief = buildBrief({
        objective,
        context: params.context,
        files,
        constraints: params.constraints,
        expectedOutput: params.expectedOutput,
        allowRead: params.allowRead === true,
      });

      // Size gate
      if (brief.length > DEFAULT_MAX_BRIEF_CHARS) {
        return {
          content: [{
            type: "text",
            text: `Brief too large (${brief.length} chars, cap ${DEFAULT_MAX_BRIEF_CHARS}). Trim the excerpts/findings and retry — send only what the worker actually needs.`,
          }],
          details: { mode: "delegate", model: target.id, target: target.kind, briefChars: brief.length },
          isError: true,
        };
      }

      // Secret screening (before anything leaves the machine)
      const screen = screenBrief(brief);
      if (screen.refused) {
        return {
          content: [{ type: "text", text: `Delegation ${screen.reason}` }],
          details: { mode: "delegate", model: target.id, target: target.kind, screened: "refused" },
          isError: true,
        };
      }

      const estTokens = Math.ceil(screen.redacted.length / 4);
      const fileSummary = files.map((f) => `\`${f.path}\` (${f.excerpt.length} chars)`).join(", ");
      const kindLabel = target.kind === "draft" ? "draft worker" : target.kind === "local" ? "local worker" : "cloud model";
      const status = [
        `Offloading to ${kindLabel} ${target.name} (\`${target.id}\`)…`,
        `Context: ${files.length} file${files.length === 1 ? "" : "s"} / ~${estTokens} tokens` +
          (files.length ? ` — ${fileSummary}` : ""),
        screen.redactionCount ? `Redacted ${screen.redactionCount} probable-sensitive span(s).` : "",
      ].filter(Boolean).join("\n");

      onUpdate?.({
        content: [{ type: "text", text: status }],
      });

      // Audit: record exactly what is about to be sent (post-screening).
      auditLog(
        [
          `\n==== ${new Date().toISOString()} — delegate → ${target.kind}:${target.id}`,
          `files: ${files.length}  estTokens: ~${estTokens}  redacted: ${screen.redactionCount}`,
          ...files.map((f) => `  file: ${f.path} (${f.excerpt.length} chars)`),
          "--- brief (redacted) ---",
          screen.redacted,
          "--- end brief ---",
        ].join("\n") + "\n",
      );

      const thinking = params.thinking ?? (target.kind === "draft" ? "" : target.kind === "local" ? "minimal" : "high");
      const timeoutSeconds = Math.max(10, Math.min(3600, params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
      const modelRef = `${target.provider}/${target.id}`;

      const outcome = await runWorker(
        ctx.cwd,
        modelRef,
        thinking,
        params.allowRead === true,
        screen.redacted,
        timeoutSeconds,
      );

      if (!outcome.ok) {
        const fallbackHint = target.kind === "local"
          ? "\n\nThe local worker failed. Do this task yourself on the cloud primary — do NOT retry the local worker repeatedly."
          : target.kind === "draft"
            ? "\n\nThe draft worker failed (rate limit, credit exhausted, or auth). Do this task inline on the cloud primary — do NOT retry the draft worker in a loop."
            : "";
        return {
          content: [{ type: "text", text: `Delegation to ${target.id} failed: ${outcome.error}${fallbackHint}` }],
          details: {
            mode: "delegate",
            model: target.id,
            target: target.kind,
            error: outcome.error,
            durationMs: outcome.durationMs,
            briefChars: screen.redacted.length,
            estTokens,
            filesIncluded: files.map((f) => f.path),
          },
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `[offloaded to ${target.id} (${target.kind}) — ~${estTokens} tokens in, ${outcome.durationMs}ms]\n\n${outcome.output}`,
        }],
        details: {
          mode: "delegate",
          target: target.kind,
          model: target.id,
          modelName: target.name,
          actualModel: outcome.actualModel,
          durationMs: outcome.durationMs,
          briefChars: screen.redacted.length,
          estTokens,
          filesIncluded: files.map((f) => f.path),
          redactionCount: screen.redactionCount,
          allowRead: params.allowRead === true,
        },
      };
    },

    renderCall(args, theme) {
      const model = (args.model || "list");
      const files = args.files?.length ?? 0;
      let text = theme.fg("toolTitle", theme.bold("delegate ")) + theme.fg("accent", model);
      if (files > 0) text += theme.fg("muted", ` (${files} file${files === 1 ? "" : "s"})`);
      const obj = args.objective ? (args.objective.length > 50 ? `${args.objective.slice(0, 50)}...` : args.objective) : "";
      if (obj) text += `\n  ${theme.fg("dim", obj)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _ctx) {
      const text = result.content?.[0]?.text ?? "(no output)";
      const d = result.details;
      if (d?.mode === "list") {
        return new Text(theme.fg("toolOutput", text.slice(0, 4000)), 0, 0);
      }
      const lines = text.split("\n");
      const preview = lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n${theme.fg("muted", `… (${lines.length - 8} more lines)`)})` : "");
      return new Text(theme.fg("toolOutput", preview), 0, 0);
    },
  });
}
