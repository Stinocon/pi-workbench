// ~/.pi/agent/extensions/docs.ts
//
// Tool nativo pi per la conversione documenti → Markdown (anydoc). Delegato a
// docs.py (skill globale `docs`), che è stdlib-only e si auto-provisiona un venv
// pinnato (~/.pi/agent/venvs/anydoc-venv, firecrawl-anydoc==0.2.3) al primo uso.
// L'estensione espone solo la chiamata tipizzata; la logica Python resta nello script.
//
// Cosa espone:
//   doc_to_markdown(path, output?) — converte Word/PPT/Excel/ODF/RTF/EPUB/CSV/PDF in
//   Markdown GFM, in locale. Per documenti grandi usa `output` (scrive su file) e leggi dopo.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DOCS = path.join(os.homedir(), ".pi", "agent", "skills", "docs", "docs.py");
const MAX_TEXT = 50_000; // cap sul Markdown restituito al modello (per documenti grandi usa `output`)

function runDocs(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("python3", [DOCS, ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) {
        code = typeof err.code === "number" ? err.code : 1;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "doc_to_markdown",
    label: "Document → Markdown",
    description:
      "Converte un documento (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF) in " +
      "Markdown GFM pulito via anydoc, in locale (nessun servizio esterno, dato non lascia la " +
      "macchina). Per documenti grandi usa `output` per scrivere su file e leggerlo dopo. " +
      "PDF scansionati/immagini non gestiti (servirebbe OCR).",
    parameters: Type.Object({
      path: Type.String({ description: "Percorso del file da convertire" }),
      output: Type.Optional(
        Type.String({ description: "Scrivi il Markdown su questo file invece di restituirlo" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const file = String(params.path);
      const out = params.output ? String(params.output) : null;
      const { code, stdout, stderr } = await runDocs(out ? [file, "-o", out] : [file]);

      if (code !== 0) {
        const msg = stderr.trim() || `conversione fallita (exit ${code})`;
        return { content: [{ type: "text", text: `doc_to_markdown errore: ${msg}` }], details: {} };
      }

      if (out) {
        return {
          content: [
            {
              type: "text",
              text: `Markdown scritto su ${out}. Leggi il file per il contenuto (${stdout.length} caratteri convertiti).`,
            },
          ],
          details: {},
        };
      }

      const preview = stdout.slice(0, MAX_TEXT);
      const suffix =
        stdout.length > preview.length
          ? `\n…[troncato: ${stdout.length - preview.length} caratteri — usa \`output\` per il file completo]`
          : "";
      return { content: [{ type: "text", text: preview + suffix }], details: {} };
    },
  });
}
