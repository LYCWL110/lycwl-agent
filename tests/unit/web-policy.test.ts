import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyAddress,
  classifyAddresses,
  formatFetchPreview,
  requiresExplicitLocalApproval,
  validateWebFetch,
  validateWebSearch,
  WEB_LIMITS,
} from "../../src/domain/web/web-policy.ts";

describe("web_search validation", () => {
  it("accepts a bounded query with the default count and fixed depth", () => {
    const result = validateWebSearch(
      { query: "typescript strict mode" },
      { surchargeRulesReviewed: true },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.count, WEB_LIMITS.defaultSearchCount);
    assert.equal(result.value.vendorDepth, WEB_LIMITS.fixedVendorDepth);
  });

  it("rejects an empty or whitespace-only query", () => {
    for (const query of ["", "   "]) {
      assert.deepEqual(validateWebSearch({ query }, { surchargeRulesReviewed: true }), {
        ok: false,
        code: "invalid_query",
      });
    }
  });

  it("rejects control characters and over-long queries", () => {
    assert.deepEqual(
      validateWebSearch({ query: "bad\u0000query" }, { surchargeRulesReviewed: true }),
      { ok: false, code: "control_character" },
    );
    assert.deepEqual(
      validateWebSearch(
        { query: "x".repeat(WEB_LIMITS.maxQueryCodePoints + 1) },
        { surchargeRulesReviewed: true },
      ),
      { ok: false, code: "query_too_long" },
    );
  });

  it("enforces the 1-10 count range", () => {
    for (const count of [0, 11, 1.5]) {
      assert.deepEqual(validateWebSearch({ query: "q", count }, { surchargeRulesReviewed: true }), {
        ok: false,
        code: "invalid_count",
      });
    }
    const ok = validateWebSearch({ query: "q", count: 5 }, { surchargeRulesReviewed: true });
    assert.equal(ok.ok, true);
  });

  it("rejects surcharge operators without rewriting the query", () => {
    assert.deepEqual(
      validateWebSearch({ query: "site:example.com foo" }, { surchargeRulesReviewed: false }),
      { ok: false, code: "fee_classification_unknown" },
    );
    assert.deepEqual(
      validateWebSearch({ query: "site:example.com foo" }, { surchargeRulesReviewed: true }),
      { ok: false, code: "surcharge_rejected" },
    );
    assert.deepEqual(validateWebSearch({ query: "FILE:foo" }, { surchargeRulesReviewed: true }), {
      ok: true,
      value: { query: "FILE:foo", count: 10, vendorDepth: 10 },
    });
  });
});

describe("web_fetch validation", () => {
  it("accepts an https URL", () => {
    const result = validateWebFetch({ url: "https://example.com/a?b=1" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.scheme, "https");
    assert.equal(result.value.host, "example.com");
    assert.equal(result.value.port, null);
  });

  it("accepts http so the caller can show the unencrypted warning", () => {
    const result = validateWebFetch({ url: "http://example.com/" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.scheme, "http");
  });

  it("rejects unsupported schemes and userinfo", () => {
    assert.deepEqual(validateWebFetch({ url: "ftp://example.com/" }), {
      ok: false,
      code: "unsupported_scheme",
    });
    assert.deepEqual(validateWebFetch({ url: "file:///C:/secret" }), {
      ok: false,
      code: "unsupported_scheme",
    });
    assert.deepEqual(validateWebFetch({ url: "https://user:pass@example.com/" }), {
      ok: false,
      code: "url_userinfo_forbidden",
    });
  });

  it("rejects a malformed URL or control character", () => {
    for (const url of ["", "not a url", "https://exa mple.com"]) {
      assert.deepEqual(validateWebFetch({ url }), { ok: false, code: "invalid_url" });
    }
    assert.deepEqual(validateWebFetch({ url: "https://example.com/\u0001" }), {
      ok: false,
      code: "control_character",
    });
  });

  it("allows only Accept and Accept-Language headers", () => {
    const ok = validateWebFetch({
      url: "https://example.com/",
      headers: { Accept: "text/html", "Accept-Language": "en-US" },
    });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.deepEqual(ok.value.headers, { accept: "text/html", "accept-language": "en-US" });

    for (const name of ["Authorization", "Cookie", "Host", "X-Custom"]) {
      assert.deepEqual(
        validateWebFetch({ url: "https://example.com/", headers: { [name]: "v" } }),
        { ok: false, code: "header_not_allowed" },
      );
    }
  });

  it("rejects duplicate names, non-ASCII values and over-long values", () => {
    assert.deepEqual(
      validateWebFetch({ url: "https://example.com/", headers: { Accept: "a", accept: "b" } }),
      { ok: false, code: "duplicate_header" },
    );
    assert.deepEqual(
      validateWebFetch({ url: "https://example.com/", headers: { Accept: "文本" } }),
      { ok: false, code: "invalid_header" },
    );
    assert.deepEqual(
      validateWebFetch({
        url: "https://example.com/",
        headers: { Accept: "x".repeat(WEB_LIMITS.maxHeaderValueBytes + 1) },
      }),
      { ok: false, code: "header_value_too_long" },
    );
  });
});

describe("address classification", () => {
  it("classifies IPv4 destinations", () => {
    assert.equal(classifyAddress("8.8.8.8"), "public");
    assert.equal(classifyAddress("127.0.0.1"), "loopback");
    assert.equal(classifyAddress("10.1.2.3"), "private");
    assert.equal(classifyAddress("172.16.0.1"), "private");
    assert.equal(classifyAddress("172.32.0.1"), "public");
    assert.equal(classifyAddress("192.168.1.1"), "private");
    assert.equal(classifyAddress("169.254.1.1"), "link_local");
    assert.equal(classifyAddress("169.254.169.254"), "cloud_metadata");
    assert.equal(classifyAddress("0.0.0.0"), "unspecified");
    assert.equal(classifyAddress("224.0.0.1"), "multicast");
  });

  it("classifies IPv6 destinations", () => {
    assert.equal(classifyAddress("::1"), "loopback");
    assert.equal(classifyAddress("fe80::1"), "link_local");
    assert.equal(classifyAddress("fd00::1"), "private");
    assert.equal(classifyAddress("ff02::1"), "multicast");
    assert.equal(classifyAddress("2606:4700::1111"), "public");
  });

  it("requires explicit approval for any non-public address", () => {
    const mixed = classifyAddresses([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    assert.equal(requiresExplicitLocalApproval(mixed), true);
    assert.deepEqual(
      mixed.map((entry) => entry.class),
      ["public", "loopback"],
    );
    assert.equal(
      requiresExplicitLocalApproval(classifyAddresses([{ address: "8.8.8.8", family: 4 }])),
      false,
    );
  });
});

describe("fetch preview", () => {
  it("lists every address with its classification and the caps", () => {
    const validated = validateWebFetch({ url: "https://example.com/" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const text = formatFetchPreview(
      validated.value,
      classifyAddresses([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    assert.match(text, /url=https:\/\/example\.com\//);
    assert.match(text, /93\.184\.216\.34\[public\]/);
    assert.match(text, /10\.0\.0\.5\[private\]/);
    assert.match(text, /rawLimit=5242880 bytes/);
    assert.match(text, /modelLimit=100000 UTF-16 units/);
    assert.match(text, /redirects=never followed automatically/);
    assert.match(text, /warning=target resolves to a non-public address/);
  });

  it("adds an explicit plaintext warning for http", () => {
    const validated = validateWebFetch({ url: "http://example.com/" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const text = formatFetchPreview(
      validated.value,
      classifyAddresses([{ address: "93.184.216.34", family: 4 }]),
    );
    assert.match(text, /UNENCRYPTED http/);
    assert.doesNotMatch(text, /warning=target resolves/);
  });
});
