// Characterization of the URL policy parity between the main-process
// connection test and the renderer policy modules (constants.mts /
// urlUtils.ts): private-LAN HTTP allowance, public HTTP denial, IPv4/IPv6/
// .local/.ts.net hosts, URL decorators, endpoint suffix stripping and
// model-list candidate ordering. Pins the equivalence the connection test
// now relies on by importing the shared helpers directly.
const test = require("node:test");
const assert = require("node:assert/strict");

const providerTest = require("../../src/helpers/providerConnectionTest.ts");
const { isSecureHttpEndpoint } = require("../../src/utils/urlUtils.ts");
const { normalizeBaseUrl, getModelListBaseCandidates } = require("../../src/config/constants.mts");

const BASE_URLS = [
  "https://api.example.com/v1",
  "https://host/api/v0",
  "http://localhost:3000/v1",
  "http://127.0.0.1:11434",
  "http://10.0.0.5:8080/v1",
  "http://192.168.1.20",
  "http://172.16.0.1",
  "http://100.72.5.9",
  "http://169.254.9.9",
  "http://[::1]:9000",
  "http://[fe80::1]:9000",
  "http://[fd00::1]:9000",
  "http://myhost.local",
  "http://tailnet-host.ts.net",
  "https://api.example.com/v1/chat/completions",
  "https://api.example.com/v1/models",
  "https://api.example.com/v1/audio/transcriptions",
  "https://api.example.com/v1/responses",
  "https://api.example.com/v1/audio/translations",
  "https://api.example.com/chat/completions",
  "https://api.example.com/v1/chat/completions?api-version=2025-03-01-preview",
  "https://api.example.com/v1/chat/completions#frag",
  "  https://api.example.com/v1/  ",
  "https://api.example.com//v1//",
];

test("secure-host policy agrees on private/public HTTP across the matrix", () => {
  const expectations = [
    ["http://localhost:3000/v1", true],
    ["http://127.0.0.1:11434", true],
    ["http://10.0.0.5:8080/v1", true],
    ["http://192.168.1.20", true],
    ["http://172.16.0.1", true],
    ["http://100.72.5.9", true],
    ["http://169.254.9.9", true],
    ["http://[::1]:9000", true],
    ["http://[fe80::1]:9000", true],
    ["http://[fd00::1]:9000", true],
    ["http://myhost.local", true],
    ["http://tailnet-host.ts.net", true],
    ["http://api.example.com", false],
    ["http://8.8.8.8", false],
    ["https://api.example.com", true],
    ["ftp://api.example.com", false],
    ["not a url", false],
  ];
  for (const [url, expected] of expectations) {
    assert.equal(isSecureHttpEndpoint(url), expected, url);
  }
});

test("normalizeBaseUrl and candidates agree across suffixes and decorators", () => {
  for (const [url, expected] of [
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/models", "https://api.example.com/v1"],
    ["https://api.example.com/v1/audio/transcriptions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1"],
    ["https://api.example.com/v1/chat/completions?api-version=2025-03-01-preview", "https://api.example.com/v1?api-version=2025-03-01-preview"],
    ["  https://api.example.com/v1/  ", "https://api.example.com/v1"],
  ]) {
    assert.equal(normalizeBaseUrl(url), expected, url);
  }
  // Every candidate ends in a bare base; /models endpoints are derived from it.
  for (const url of BASE_URLS) {
    for (const candidate of getModelListBaseCandidates(url)) {
      assert.ok(!/\/(models|chat\/completions|responses)$/.test(candidate), `${url} → ${candidate}`);
    }
  }
});

test("resolveProviderRequest custom endpoints honor the same private-HTTP rule", () => {
  const lan = providerTest.resolveProviderRequest({ provider: "custom", baseUrl: "http://10.0.0.5:8080/v1", apiKey: "k" });
  assert.equal(lan.endpoints.length > 0, true);
  assert.match(lan.endpoints[0], /^http:\/\/10\.0\.0\.5:8080\/v1\/models$/);

  assert.throws(
    () => providerTest.resolveProviderRequest({ provider: "custom", baseUrl: "http://api.example.com/v1", apiKey: "k" }),
    /Public endpoints must use HTTPS/
  );
});
