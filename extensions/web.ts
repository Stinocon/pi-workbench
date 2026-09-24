// ~/.pi/agent/extensions/web.ts
//
// Web fetch + search per pi. IDEA distillata da pi-web-access (MIT, github.com/nicobailon/pi-web-access):
// prendiamo SOLO il concetto di guardia SSRF (risoluzione DNS + blocco indirizzi privati/interni +
// ri-validazione dei redirect), reimplementato in forma minima. Niente 25 provider, niente video,
// niente GitHub-clone, niente curator server. Provenienza per §6 ("idea sì, plugin no").
//
// Cosa espone:
//   web_fetch(url)  — scarica una pagina http(s), blocca SSRF con l'indirizzo PINNATO, restituisce testo.
//   web_search(q,n) — ricerca keyless via DuckDuckGo (best-effort; può fallire per rate-limit).
//
// Entrambe passano da `requestPinned`: l'hostname viene risolto e validato UNA volta, e la
// connessione usa quell'indirizzo (`lookup`), quindi un nome che cambia risposta fra il controllo e
// la connessione (DNS rebinding) non porta il socket su un indirizzo privato.
//
// Uso per il metodo del progetto: SOLO lookup impersonali (normativa, TER, aliquote, età pensionabile).
// MAI dati finanziari personali (AGENTS.md §6).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

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

/** A URL whose resolution was validated, together with the addresses the connection must use. */
interface Pinned {
	url: URL;
	addresses: string[];
}

async function validateUrl(raw: string | URL): Promise<Pinned> {
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
    return { url: u, addresses: [host] };
  }
  let addrs;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch (e) {
    throw new Error(`Risoluzione DNS fallita per ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!addrs.length) throw new Error(`Risoluzione DNS fallita per ${host} (nessun indirizzo)`);
  for (const { address } of addrs) assertPublic(address);
  // The addresses are RETURNED, not just checked: the connection is pinned to them below. Checking
  // and then letting the runtime resolve again is the DNS-rebinding hole — the name answers with a
  // public address for the check and a private one for the connection.
  return { url: u, addresses: addrs.map((a) => a.address) };
}

/**
 * `lookup` for net/tls: hands back an address that was already validated, so no second resolution
 * happens and the socket cannot land somewhere the check never saw.
 */
function pinnedLookup(addresses: string[]): LookupFunction {
	return ((_hostname: string, options: { all?: boolean }, callback: (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
		const first = addresses[0] ?? "";
		if (options?.all === true) {
			callback(null, addresses.map((a) => ({ address: a, family: isIP(a) })));
			return;
		}
		callback(null, first, isIP(first));
	}) as unknown as LookupFunction;
}

interface PinnedResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: Uint8Array;
}

/**
 * GET with the connection pinned to an address that was already validated.
 *
 * Why not `fetch`: it resolves the hostname itself, so the check above and the connection it makes
 * are two different resolutions. `lookup` is what the socket uses INSTEAD of the resolver, so
 * passing the validated addresses there is what turns the check into a guarantee. (undici's
 * dispatcher would be the other way; it is not importable from here, and node:http(s) is stdlib.)
 *
 * TLS keeps SNI and certificate validation tied to the NAME via `servername`, while the socket goes
 * to the validated address. The cap is applied to the DECOMPRESSED stream: a compressed bomb is
 * measured by what it expands to, not by what it weighs on the wire.
 */
function requestPinned(target: Pinned, maxBytes: number): Promise<PinnedResponse> {
	const isHttps = target.url.protocol === "https:";
	const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (e: Error) => {
			if (!settled) {
				settled = true;
				reject(e);
			}
		};
		const done = (value: PinnedResponse) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const request = (isHttps ? httpsRequest : httpRequest)(
			{
				hostname,
				port: target.url.port || (isHttps ? 443 : 80),
				path: `${target.url.pathname}${target.url.search}`,
				method: "GET",
				headers: {
					"user-agent": "pi-web-tool/1.0",
					accept: "text/html,text/plain,*/*",
					"accept-encoding": "gzip, deflate, br",
				},
				...(isHttps ? { servername: hostname } : {}),
				lookup: pinnedLookup(target.addresses),
				signal: AbortSignal.timeout(15000),
			},
			(res) => {
				const encodings = String(res.headers["content-encoding"] ?? "")
					.toLowerCase()
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				// Stacked encodings (`gzip, br`) need the decoders applied in reverse order. Picking one and
				// returning its output as text would hand the caller bytes that were never fully decoded —
				// something that looks like text and is not.
				if (encodings.length > 1) {
					res.destroy();
					fail(new Error(`content-encoding multipla non supportata (${encodings.join(", ")})`));
					return;
				}
				const encoding = encodings[0] ?? "";
				let stream: NodeJS.ReadableStream = res;
				try {
					if (encoding === "br") stream = res.pipe(createBrotliDecompress());
					else if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
					else if (encoding === "deflate") stream = res.pipe(createInflate());
				} catch (e) {
					res.destroy();
					fail(e instanceof Error ? e : new Error(String(e)));
					return;
				}
				const chunks: Buffer[] = [];
				let total = 0;
				stream.on("data", (chunk: Buffer) => {
					if (settled) return;
					total += chunk.length;
					if (total > maxBytes) {
						res.destroy();
						fail(new Error(`Corpo troppo grande (oltre ${maxBytes} byte)`));
						return;
					}
					chunks.push(chunk);
				});
				stream.on("error", (e: Error) => {
					// Destroy the response too. Settling the promise alone left the raw socket streaming into a
					// decoder that had already given up, until the 15 s timeout — a socket a hostile server
					// holds open for free, on every fetch.
					res.destroy();
					fail(e);
				});
				stream.on("end", () =>
					done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
				);
			},
		);
		request.on("error", (e: Error) => fail(new Error(`richiesta fallita: ${e.message}`)));
		request.end();
	});
}

async function fetchGuarded(rawUrl: string): Promise<string> {
	let target = await validateUrl(rawUrl);
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const res = await requestPinned(target, MAX_BYTES);
		if (res.status >= 300 && res.status < 400) {
			const raw = res.headers.location;
			const location = Array.isArray(raw) ? raw[0] : raw;
			if (!location) throw new Error("Redirect senza Location");
			// Every hop is re-validated AND re-pinned: a redirect to an internal name must fail the
			// same checks the first URL did.
			target = await validateUrl(new URL(location, target.url));
			continue;
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`HTTP ${res.status} per ${target.url.toString()}`);
		}
		return new TextDecoder().decode(res.body);
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

// Exported for the regression test: the pin is only observable by driving a request whose NAME does
// not resolve to the address it is pinned to, and that needs the functions directly. Exporting them
// is cheaper than trusting a comment that says the connection is pinned.
export { blockedIPv4, blockedIPv6, requestPinned, validateUrl };

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
        const target = await validateUrl(`https://html.duckduckgo.com/html/?q=${q}`);
        // Same pinned path as web_fetch: one code path, one guarantee.
        const res = await requestPinned(target, MAX_SEARCH_BYTES);
        const html = new TextDecoder().decode(res.body);
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
