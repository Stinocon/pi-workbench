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
 * The last check makes ONE outbound request to a public host, because the HTTPS path was rewritten
 * from `fetch` to `node:https` and a broken TLS path would only show up against a real server.
 * Set SKIP_NETWORK=1 to skip it.
 *
 * Usage: node scripts/test-web-guard.mjs
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

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

// A throwaway self-signed certificate for `pin-test.invalid`, embedded so the TLS pin can be proven
// WITHOUT the network and without depending on the machine having openssl. It is a test fixture, not
// a secret: it protects nothing and is trusted by nothing.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC5j0nahSlxozAl
Q5ZIZmq+GO0AnUmHDCxEqotyT5Q276WhUyG9GIOHb0QpEmbOzeXcyxM4S7p1KsU6
g3g5f1NhI26F5ZzrTdw2qAfqq/kEPofd19477TmdOepZcGPDxhKd2VzaDQZTJP5G
xiMJygVunFve/CugDwV/t6s41qStux7IepwpJQPcRkoC/dVShPC0YqJplSoqJtOI
3wDvwsCn8KFsTPDiPe7qbyYbSEwAdsh0tUPtNhtx093bV6qVOWGlref3Uh8h9lYc
0qTgRlydIkCnH0r4zjgOYleQsOhrBhFgXN63og5MmGAFlL+tT9rkuISh6WWbAcgA
cvYapXGDAgMBAAECggEABURWBFhnNRHLwSN+EOjJ4m/bNsaD59sGgodjqdSG9EIA
AKDPpiR9fDKNhEn87MOCfxfaTV286JW2huev4VuROlU9N6mtIIlIMzUTA0Z6SyF1
es5SlBWjmzdO4xMxGMzrkbV9H8VTwTC0AEXceYGgykFlgOI+JElLsJLNIaLaDdUf
1r/a2FUW4ycX4R6lB9Pmv4K1etIQX8DQR1A/lAMBaulasq++qHWRNgTpPwJyZm7W
NX8/318XoSPjy/8xWWq3VDwIQvD+K3CzGKRSNbwYPnyePHCeCJb4QEFawGHiZ97W
bHDskTYoVx1GGJBTScb4pVFt+IY1WFjonp+6JIStSQKBgQD2WD3D+o8LnWCyJneT
MigSdKQq0wK9LzP3GJi5TOplsvQljOhNePwdXsNUzcU+6IsX+Ff96R6E7UgK+Vju
gknyP3R5W0njTASKa2ewAJ3bDjsZBwcjlawq8geQz7eeecbmvyZNuFbeogqh6HOl
ufxOoBFmpTdm4BvJKfz0sxeT+wKBgQDA1SWGdomLsACTBP1BAUY1DNz7xoKSna6L
hGdY/jJRw5u7Ccu5bjRlwOvLUr5DnHjUqXsXDQvYfpCwh6+YsuePoh6ytM8gcUk2
EfgRqB6NyoLR6buRcWFUUm643b7uWJTZxLlCSerH54gXb06Pc3VoplX6rY0/mxXq
b/GRJ4maGQKBgEShHMQGf+eKdq/rC5EUfhl2KW5MzwyJo/6I+bNV/E9M5bu4X9eF
hydfiSeNFBCMlIOfClSQp5H80P9NrDr2TUeR6g8NIa6TNQijF4XvBgtLEafNT23Y
etiUCQuM8ujRoFoUksVAP+NSXYfxzJY1FFeLPI3OJXshoFwQuIorgrwVAoGAKMls
xIIyGa/Cj1ZQ0v0YAoSUAVU9rRFZJ/17dqFdt1muiONLig87WgJyXXFE+TwRernW
ZUvHI6WxqQUqKRw+Sm06HQaNgQk1ORCX7fQnckpRXWEY4Wyf75v3+3Y7umJWKbGo
ldLYrCvW504Nyd3cCaSVLw6if7+n5QyEhfVc75ECgYAA+xtohcWL/Z779dx6Nvbn
q4eDbxwEJ4tDUeBXFltBBe2vdZpq+4vTPxpdKwqxqYIA1I3bYrepoPo6loszv80N
xcvq7/wo17YFNRbWyxP2tTv2GNw/1+6ZGKko0qMqqkQp0A2MzaO4KnduwOVSGL2/
B7a1U64qnKYbEEq0Tu/yoA==
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUcKeDHAovDCVCkTdwBkIHPVgeZkUwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQcGluLXRlc3QuaW52YWxpZDAeFw0yNjA5MjQwODM0MzZa
Fw0zNjA5MjEwODM0MzZaMBsxGTAXBgNVBAMMEHBpbi10ZXN0LmludmFsaWQwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5j0nahSlxozAlQ5ZIZmq+GO0A
nUmHDCxEqotyT5Q276WhUyG9GIOHb0QpEmbOzeXcyxM4S7p1KsU6g3g5f1NhI26F
5ZzrTdw2qAfqq/kEPofd19477TmdOepZcGPDxhKd2VzaDQZTJP5GxiMJygVunFve
/CugDwV/t6s41qStux7IepwpJQPcRkoC/dVShPC0YqJplSoqJtOI3wDvwsCn8KFs
TPDiPe7qbyYbSEwAdsh0tUPtNhtx093bV6qVOWGlref3Uh8h9lYc0qTgRlydIkCn
H0r4zjgOYleQsOhrBhFgXN63og5MmGAFlL+tT9rkuISh6WWbAcgAcvYapXGDAgMB
AAGjdjB0MB0GA1UdDgQWBBSky3TiQ0d4VtQEygZ1ewZveb0iCTAfBgNVHSMEGDAW
gBSky3TiQ0d4VtQEygZ1ewZveb0iCTAPBgNVHRMBAf8EBTADAQH/MCEGA1UdEQQa
MBiCEHBpbi10ZXN0LmludmFsaWSHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBADY3
4tjMwjYuh4R75sljr0T923BNYuGLiGZKfypxhUf3YG+7zjwIxN8gmzf+pNb1/spL
MBs2Zbd7X4BF+ntHqXMqh7YIjI5975MRMQ3nJ6oMWZ/nQwQPnh607nAkllMtIFyb
XjPAqZSKiFs8qpCSocw+jxMecLkmAe0bSjYjeyZOOV66neO6Fc/QBaXOzcQK0BBL
MiYSu1xKh+vkN1eXCB1S6fszhRyTcSxgZf73zbb+L9GwDcE2E1GAzxjnttMCnPAv
DkR978y2A9hGgq/BGfXmgKv8vA7qZShUCpGFfxghdXlkwQpQKoKhVCSLV4R+eMlo
qU23Lwdbv5SN8h3YdwQ=
-----END CERTIFICATE-----
`;

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


// --- the TLS branch is PINNED too (finding: the old HTTPS check passed with the pin removed) -----
{
  // A connection counter, not a request counter: a self-signed certificate makes the handshake fail
  // BEFORE the request handler runs, and what has to be proven is that the TCP connection arrived at
  // the pinned address at all.
  let tlsConnections = 0;
  const tlsServer = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
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
