// ~/.pi/agent/extensions/web.ts
//
// Web fetch + search per pi. IDEA distillata da pi-web-access (MIT, github.com/nicobailon/pi-web-access):
// prendiamo SOLO il concetto di guardia SSRF (risoluzione DNS + blocco indirizzi privati/interni +
// ri-validazione dei redirect), reimplementato in forma minima. Niente 25 provider, niente video,
// niente GitHub-clone, niente curator server. Provenienza per §6 ("idea sì, plugin no").
//
// Cosa espone:
//   web_fetch(url)  — scarica una pagina http(s), blocca SSRF, restituisce testo (HTML strippato, ~12KB).
//   web_search(q,n) — ricerca keyless via DuckDuckGo (best-effort; può fallire per rate-limit).
//
// Uso per il metodo del progetto: SOLO lookup impersonali (normativa, TER, aliquote, età pensionabile).
// MAI dati finanziari personali (AGENTS.md §6).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 200_000; // cap sul corpo scaricato (i file enormi non si riversano nel contesto)
const MAX_SEARCH_BYTES = 1_000_000; // la pagina dei risultati DDG è più grande di una pagina normale
const MAX_REDIRECTS = 5;
const PREVIEW_CHARS = 12_000;

// ── Guardia SSRF (distillata e semplificata) ─────────────────────────────
function blockedIPv4(oct: number[]): boolean {
  const [a, b] = oct;
  return (
    a === 0 ||            // 0.0.0.0/8
    a === 10 ||           // 10.0.0.0/8
    a === 127 ||          // 127.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) ||           // link-local
    (a === 172 && b >= 16 && b <= 31) ||  // 172.16/12
    (a === 192 && b === 168) ||           // 192.168/16
    a >= 224                              // multicast + reserved
  );
}

/**
 * Decode the IPv4 embedded in an IPv6 address, if any: IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96) and NAT64 (64:ff9b::/96).
 *
 * Why this exists: the URL parser canonicalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a
 * check written against the dotted form never fires on a real hostname — the hextets are the only
 * representation that matches what the connection will actually use.
 */
function embeddedIPv4(n: string): number[] | undefined {
  let tail: string;
  if (n.startsWith("::ffff:")) tail = n.slice(7);
  else if (n.startsWith("64:ff9b::")) tail = n.slice(9);
  else if (n.startsWith("::")) tail = n.slice(2);
  else return undefined;
  if (!tail) return undefined;
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    return o.length === 4 && o.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? o : undefined;
  }
  const h = tail.split(":");
  if (h.length !== 2 || !h.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return undefined;
  const hi = parseInt(h[0], 16);
  const lo = parseInt(h[1], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function blockedIPv6(addr: string): boolean {
  const n = addr.toLowerCase();
  if (n === "::" || n === "::1") return true;
  if (n.startsWith("fc") || n.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(n)) return true; // fe80::/10 link-local
  const v4 = embeddedIPv4(n);
  if (v4) return blockedIPv4(v4);
  return false;
}

function assertPublic(addr: string): void {
  const v = isIP(addr);
  if (v === 4) {
    const o = addr.split(".").map(Number);
    if (o.length !== 4 || o.some((x) => !Number.isInteger(x)) || blockedIPv4(o)) {
      throw new Error(`SSRF: indirizzo interno/privato bloccato (${addr})`);
    }
  } else if (v === 6) {
    if (blockedIPv6(addr)) throw new Error(`SSRF: indirizzo interno/privato bloccato (${addr})`);
  } else {
    throw new Error(`SSRF: indirizzo non IP (${addr})`);
  }
}

async function validateUrl(raw: string | URL): Promise<URL> {
  const u = raw instanceof URL ? raw : new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Solo URL http/https");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new Error("URL senza hostname");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("SSRF: localhost bloccato");
  }
  if (isIP(host)) {
    assertPublic(host);
    return u;
  }
  // risolvi il nome e blocca ogni indirizzo risolto non pubblico (evita DNS-rebinding)
  let addrs;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch (e) {
    throw new Error(`Risoluzione DNS fallita per ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!addrs.length) throw new Error(`Risoluzione DNS fallita per ${host} (nessun indirizzo)`);
  for (const { address } of addrs) assertPublic(address);
  // Limite dichiarato: `fetch` qui sotto risolve il nome una seconda volta da sé, quindi un nome
  // ostile che cambia risposta fra le due risoluzioni (DNS rebinding) può ancora raggiungere un
  // indirizzo privato. Pinnare l'IP validato richiede un dispatcher undici con `connect`/`lookup`
  // propri — non implementato qui. La difesa reale è che OGNI risoluzione viene validata, non che
  // sia quella che la connessione userà: nessun claim più forte di questo va scritto in un commento.
  return u;
}

/** Legge il corpo applicando il cap durante lo streaming: `arrayBuffer()` bufferizza tutto prima di
 *  poter misurare, quindi un corpo enorme diventerebbe memoria occupata prima di essere rifiutato. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`Corpo troppo grande (Content-Length ${declared} byte, max ${max})`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Corpo troppo grande (oltre ${max} byte)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function fetchGuarded(rawUrl: string): Promise<string> {
  let url = await validateUrl(rawUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "pi-web-tool/1.0", accept: "text/html,text/plain,*/*" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Redirect senza Location");
      url = await validateUrl(new URL(loc, url)); // ri-valida OGNI salto
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} per ${url.toString()}`);
    return new TextDecoder().decode(await readCapped(res, MAX_BYTES));
  }
  throw new Error("Troppi redirect");
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const t = u.searchParams.get("uddg");
    if (t) return decodeURIComponent(t);
  } catch {
    /* keep raw href */
  }
  return href;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Scarica una pagina http(s) e ne restituisce il testo (HTML strippato, ~12KB di anteprima). " +
      "Blocca indirizzi interni/privati (guardia SSRF con ri-validazione dei redirect). " +
      "SOLO lookup impersonali: mai dati personali.",
    parameters: Type.Object({
      url: Type.String({ description: "URL http/https da scaricare" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const raw = await fetchGuarded(String(params.url));
        const text = htmlToText(raw);
        const preview = text.slice(0, PREVIEW_CHARS);
        const suffix =
          text.length > preview.length ? `\n…[troncato: ${text.length - preview.length} caratteri in più]` : "";
        return { content: [{ type: "text", text: preview + suffix }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `web_fetch errore: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Ricerca web keyless via DuckDuckGo (best-effort: può fallire per rate-limit/CAPTCHA). " +
      "Restituisce titolo+URL+snippet. Se fallisce, ripeti o usa web_fetch su una fonte nota.",
    parameters: Type.Object({
      query: Type.String({ description: "query di ricerca" }),
      n: Type.Optional(Type.Number({ description: "numero risultati (default 5, max 10)" })),
    }),
    async execute(_toolCallId, params) {
      const n = Math.min(Math.max(Number(params.n ?? 5), 1), 10);
      try {
        const q = encodeURIComponent(String(params.query));
        const url = await validateUrl(`https://html.duckduckgo.com/html/?q=${q}`);
        const res = await fetch(url, {
          redirect: "manual",
          headers: { "user-agent": "Mozilla/5.0 (compatible; pi-web-tool/1.0)" },
          signal: AbortSignal.timeout(15000),
        });
        const html = new TextDecoder().decode(await readCapped(res, MAX_SEARCH_BYTES));
        const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(
          (m) => ({ href: cleanDdgUrl(m[1]), title: htmlToText(m[2]) }),
        );
        const snips = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
          htmlToText(m[1]),
        );
        const out = links
          .slice(0, n)
          .map((l, i) => `${i + 1}. ${l.title}\n   ${l.href}${snips[i] ? `\n   ${snips[i]}` : ""}`)
          .filter(Boolean);
        if (!out.length) {
          return {
            content: [
              {
                type: "text",
                text: "Nessun risultato (DuckDuckGo potrebbe aver rate-limitato o richiesto CAPTCHA). Riprova tra poco, o usa web_fetch su una fonte nota.",
              },
            ],
            details: {},
          };
        }
        return { content: [{ type: "text", text: out.join("\n\n") }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `web_search errore: ${e instanceof Error ? e.message : String(e)}` }],
          details: {},
        };
      }
    },
  });
}
