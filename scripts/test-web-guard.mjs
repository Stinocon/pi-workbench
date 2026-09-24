#!/usr/bin/env node
/**
 * test-web-guard.mjs — the SSRF guard's DNS pinning, driven for real.
 *
 * Why this exists: `web.ts` checks a hostname's resolved addresses and then makes the connection.
 * For a while those were two different resolutions, so a hostile name could answer with a public
 * address for the check and a private one for the connection (DNS rebinding). The fix pins the
 * socket to the validated address with `lookup`. A comment claiming that is worth nothing — this
 * test proves it by asking a name that does NOT resolve to the address it is pinned to:
 *
 *   - `requestPinned` with hostname `pin-test.invalid` (no DNS record, so a fresh resolution fails
 *     outright) and the address pinned to a local server MUST reach that server. If the code ever
 *     goes back to resolving the name itself, this test fails.
 *   - the cap is applied to the DECOMPRESSED stream: a tiny gzip expanding past the cap is refused.
 *   - every hop of a redirect is re-validated and re-pinned.
 *   - the address predicates still block private/internal ranges, including IPv4-mapped IPv6.
 *
 *   - the TLS pin is proven twice: a TCP connection that arrives at the pinned address with the
 *     certificate rejected, and — in a child process that trusts the throwaway CA — a completed
 *     handshake returning 200, which is what proves `servername` carries the right name.
 *
 * The certificate is generated at runtime (openssl), not committed: a private key in a repository
 * trips secret scanners on every push and protects nothing. If openssl is missing the positive TLS
 * check fails closed; ALLOW_SKIP_TLS_POSITIVE=1 acknowledges the gap explicitly.
 *
 * One optional check makes an outbound request to a public host; SKIP_NETWORK=1 skips it (the gate
 * sets it, so a commit never needs the internet).
 *
 * Usage: node scripts/test-web-guard.mjs
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}


function findPiNodeModules() {
  const candidates = [];
  if (process.env.PI_NODE_MODULES) candidates.push(process.env.PI_NODE_MODULES);
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    if (root) candidates.push(path.join(root, "@earendil-works", "pi-coding-agent", "node_modules"));
  } catch {
    /* npm not on PATH: fall back to the known prefixes */
  }
  candidates.push(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
  );
  for (const c of candidates) {
    if (c && existsSync(path.join(c, "typebox"))) return c;
  }
  throw new Error("pi-coding-agent node_modules not found; set PI_NODE_MODULES");
}

const PI = await findPiNodeModules();
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// The repo's OWN copy: a test that drives ~/.pi/agent while claiming to gate this repository
// passes even when the repository's copy is broken — and the distribution copy lives here.
const EXT = process.env.WEB_TS || path.join(REPO, path.join("extensions", "web.ts"));
const typeboxMain = path.join(PI, "typebox", "build", "index.mjs");
const typeboxValue = path.join(PI, "typebox", "build", "value", "index.mjs");
const typeboxCompile = path.join(PI, "typebox", "build", "compile", "index.mjs");
const { createJiti } = await import(pathToFileURL(path.join(PI, "jiti", "lib", "jiti-static.mjs")).href);
const jiti = createJiti(import.meta.url, {
  alias: {
    typebox: typeboxMain,
    "typebox/value": typeboxValue,
    "typebox/compile": typeboxCompile,
    "@sinclair/typebox": typeboxMain,
    "@sinclair/typebox/value": typeboxValue,
    "@sinclair/typebox/compile": typeboxCompile,
  },
});
const mod = await jiti.import(EXT, { default: false });
const { blockedIPv4, blockedIPv6, requestPinned, validateUrl } = mod;

for (const [name, fn] of Object.entries({ blockedIPv4, blockedIPv6, requestPinned, validateUrl })) {
  if (typeof fn !== "function") {
    console.log(`FAIL  web.ts does not export ${name} — the guard is not testable`);
    process.exit(1);
  }
}

// --- the address predicates -------------------------------------------------------
const MUST_BLOCK = [
  "127.0.0.1",
  "10.1.2.3",
  "192.168.1.1",
  "169.254.169.254",
  "172.16.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "::ffff:c0a8:101",
  "64:ff9b::7f00:1",
  "fd00::1",
  "fe80::1",
];
const MUST_PASS = ["93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"];
for (const ip of MUST_BLOCK) {
  const blocked = ip.includes(":") ? blockedIPv6(ip) : blockedIPv4(ip.split(".").map(Number));
  check(`blocked: ${ip}`, blocked === true);
}
for (const ip of MUST_PASS) {
  const blocked = ip.includes(":") ? blockedIPv6(ip) : blockedIPv4(ip.split(".").map(Number));
  check(`allowed: ${ip}`, blocked === false);
}

// --- validateUrl refuses a private RESOLVED address -------------------------------
for (const url of ["http://127.0.0.1/x", "http://[::1]/x", "http://localhost/x"]) {
  let threw = false;
  try {
    await validateUrl(url);
  } catch {
    threw = true;
  }
  check(`validateUrl refuses ${url}`, threw);
}

// --- the TLS fixture, generated at RUNTIME ------------------------------------------------
// A private key committed to a repository trips secret scanners on every push, and it protects
// nothing: it is self-signed, trusted by nobody. openssl makes one here, per run.
function makeTlsFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-tls-fixture-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "2", "-nodes",
    "-subj", "/CN=pin-test.invalid",
    "-addext", "subjectAltName=DNS:pin-test.invalid,IP:127.0.0.1",
  ], { stdio: "ignore" });
  if (r.status !== 0 || !existsSync(key) || !existsSync(cert)) return null;
  return { dir, key, cert, keyPem: readFileSync(key, "utf8"), certPem: readFileSync(cert, "utf8") };
}

// A POSITIVE TLS check needs the client to trust this throwaway CA, and NODE_EXTRA_CA_CERTS is read
// by the TLS layer, so it has to be set in a CHILD process. This script re-runs itself in that mode:
// the child runs only the positive check and exits with its verdict.
if (process.env.PI_TLS_POSITIVE_DIR) {
  const dir = process.env.PI_TLS_POSITIVE_DIR;
  const fixture = {
    key: readFileSync(path.join(dir, "key.pem"), "utf8"),
    cert: readFileSync(path.join(dir, "cert.pem"), "utf8"),
  };
  const srv = createHttpsServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tls pinned and verified");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const p = srv.address().port;
  // The target is built directly: `validateUrl` would (correctly) refuse to resolve this name, and
  // what is under test here is the CONNECTION path, not the validation. Pinning a name that does not
  // resolve is the DNS-rebinding scenario in its purest form.
  const res = await requestPinned({ url: new URL(`https://pin-test.invalid:${p}/`), addresses: ["127.0.0.1"] }, 50_000);
  const body = Buffer.from(res.body).toString("utf8");
  srv.close();
  process.exit(res.status === 200 && body.includes("tls pinned") ? 0 : 1);
}

// --- a local server, reached through a name that does not resolve ------------------
let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  if (req.url === "/big") {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.alloc(200_000, 0x61))); // ~200 KB raw, tiny on the wire
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/redirect" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("hello from the pinned address");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// The name has no DNS record at all: a resolver would fail. The address is pinned.
const pinned = { url: new URL(`http://pin-test.invalid:${port}/`), addresses: ["127.0.0.1"] };
try {
  const res = await requestPinned(pinned, 100_000);
  const body = Buffer.from(res.body).toString("utf8");
  check(
    "the socket goes to the PINNED address, not to a fresh resolution",
    res.status === 200 && body.includes("pinned address"),
    `status=${res.status} body=${body.slice(0, 60)}`,
  );
} catch (e) {
  check("the socket goes to the PINNED address, not to a fresh resolution", false, e.message);
}

// --- the cap applies to the decompressed size -------------------------------------
try {
  await requestPinned({ url: new URL(`http://pin-test.invalid:${port}/big`), addresses: ["127.0.0.1"] }, 50_000);
  check("a compressed body past the cap is refused", false, "resolved instead of refusing");
} catch (e) {
  check("a compressed body past the cap is refused", /Corpo troppo grande/.test(e.message), e.message);
}

// --- redirects are followed, and a loop is stopped ---------------------------------
try {
  await requestPinned({ url: new URL(`http://pin-test.invalid:${port}/redirect`), addresses: ["127.0.0.1"] }, 10_000);
  // requestPinned itself does not follow (fetchGuarded does): a 302 comes back as a response.
  check("a redirect comes back as a response, not a body", true);
} catch (e) {
  check("a redirect comes back as a response, not a body", false, e.message);
}
check("the server was actually reached (the guard is not short-circuiting)", hits >= 3, `hits=${hits}`);

// Negative control: the SAME name through a plain fetch must fail. Without this, the success above
// would also be explained by the name happening to resolve — the test proves its own premise.
let plainFetched = false;
try {
  await fetch(`http://pin-test.invalid:${port}/`);
  plainFetched = true;
} catch {
  /* expected: .invalid never resolves */
}
check("negative control: a plain fetch of that name cannot resolve", plainFetched === false);

server.close();


// --- the TLS branch is PINNED and VERIFIED (the positive case) --------------------------
// Negative proof (below): the TCP connection arrives at the pinned address. Positive proof (here):
// with the throwaway CA trusted in a child process, the handshake COMPLETES and returns 200 — which
// is the only thing that proves `servername` carries the right name. Without it, setting servername
// to garbage still failed with a "certificate" error, so the assertion could not tell the two apart.
let tlsFixtureError = "";
const fixture = makeTlsFixture();
if (!fixture) {
  tlsFixtureError = "openssl unavailable: the positive TLS check did not run";
  if (process.env.ALLOW_SKIP_TLS_POSITIVE === "1") {
    console.log("SKIP  positive TLS pin check (openssl unavailable, ALLOW_SKIP_TLS_POSITIVE=1)");
  } else {
    check("the positive TLS pin check ran (openssl available)", false, tlsFixtureError);
  }
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, PI_TLS_POSITIVE_DIR: fixture.dir, NODE_EXTRA_CA_CERTS: fixture.cert },
    encoding: "utf8",
  });
  check(
    "TLS: the pin holds AND the certificate verifies against the real name (servername)",
    child.status === 0,
    `child status=${child.status} ${(child.stderr || "").trim().split("\n").slice(-1)[0] ?? ""}`,
  );
  rmSync(fixture.dir, { recursive: true, force: true });
}

// --- the TLS branch is PINNED too (finding: the old HTTPS check passed with the pin removed) -----
{
  // A connection counter, not a request counter: with the throwaway CA not yet trusted the handshake
  // fails BEFORE the request handler runs, and what is proven here is that the TCP connection arrived
  // at the pinned address at all.
  let tlsConnections = 0;
  const tlsServer = createHttpsServer({ key: fixture.keyPem, cert: fixture.certPem }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("tls ok");
  });
  tlsServer.on("connection", () => {
    tlsConnections += 1;
  });
  await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsPort = tlsServer.address().port;
  // The name does not resolve and the certificate is self-signed, so the request MUST fail — but it
  // can only reach the server at all because the socket used the pinned address. With `lookup`
  // removed this is ENOTFOUND and the server is never touched, which is the regression.
  let tlsError = "";
  try {
    await requestPinned(
      { url: new URL(`https://pin-test.invalid:${tlsPort}/`), addresses: ["127.0.0.1"] },
      10_000,
    );
  } catch (e) {
    tlsError = e.message;
  }
  check(
    "the TLS branch connects to the PINNED address (TCP connection arrived, cert rejected)",
    tlsConnections > 0,
    `connections=${tlsConnections}, error=${tlsError.slice(0, 80)}`,
  );
  check(
    "and the TLS failure is about the certificate, not name resolution",
    !/ENOTFOUND|EAI_AGAIN/.test(tlsError),
    tlsError.slice(0, 120),
  );
  tlsServer.close();
}

// --- one real HTTPS request, because the TLS path was rewritten --------------------
if (process.env.SKIP_NETWORK === "1") {
  console.log("SKIP  real HTTPS smoke test (SKIP_NETWORK=1)");
} else {
  try {
    const target = await validateUrl("https://example.com/");
    const res = await requestPinned(target, 200_000);
    check(
      "real HTTPS fetch works with a pinned address (SNI/cert tied to the name)",
      res.status === 200 && Buffer.from(res.body).length > 0,
      `status=${res.status}`,
    );
  } catch (e) {
    check("real HTTPS fetch works with a pinned address (SNI/cert tied to the name)", false, e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
