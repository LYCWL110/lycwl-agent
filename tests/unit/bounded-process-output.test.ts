import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBoundedProcessOutput,
  MAX_CAPTURE_BYTES,
} from "../../src/adapters/windows/bounded-process-output.ts";
import type { OwnedKeyRegistry } from "../../src/domain/security/owned-key-guard.ts";

const KEY = "SYNTHETIC_CAPTURE_KEY_20261107";
function registry(value = KEY): OwnedKeyRegistry {
  return { keys: [{ keyId: "fixture", value, state: "retired", revision: 1 }] };
}

describe("bounded pre-persistence process capture", () => {
  it("accepts exactly the combined raw cap and observes only one excess byte", () => {
    const exact = createBoundedProcessOutput();
    const half = Buffer.alloc(MAX_CAPTURE_BYTES / 2, 0x41);
    exact.push("stdout", half);
    exact.push("stderr", half);
    exact.finish(true);
    const full = exact.snapshot();
    assert.equal(full.rawBytes, MAX_CAPTURE_BYTES);
    assert.equal(full.captureComplete, true);
    assert.equal(
      Buffer.byteLength(full.stdout) + Buffer.byteLength(full.stderr),
      MAX_CAPTURE_BYTES,
    );
    const over = createBoundedProcessOutput();
    over.push("stdout", half);
    over.push("stderr", Buffer.alloc(half.length + 10000, 0x42));
    over.finish(false);
    const result = over.snapshot();
    assert.equal(result.rawBytes, MAX_CAPTURE_BYTES + 1);
    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result.captureComplete, false);
    assert.ok(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= MAX_CAPTURE_BYTES,
    );
    over.push("stdout", half);
    assert.equal(over.snapshot().rawBytes, MAX_CAPTURE_BYTES + 1);
  });

  for (const stream of ["stdout", "stderr"] as const) {
    it(`blocks every byte split of an owned value on ${stream}`, () => {
      const bytes = Buffer.from(KEY);
      for (let cut = 1; cut < bytes.length; cut++) {
        const capture = createBoundedProcessOutput(registry());
        capture.push(stream, bytes.subarray(0, cut));
        assert.equal(capture.snapshot()[stream], "", "undecided prefix was released");
        capture.push(stream, bytes.subarray(cut));
        capture.finish(true);
        const result = capture.snapshot();
        assert.equal(result.deliveryBlocked, "owned_key_detected");
        assert.equal(result.captureComplete, false);
        assert.equal(result.stdout + result.stderr, "");
      }
    });
  }

  it("checks all output, including values beyond the model excerpt", () => {
    const capture = createBoundedProcessOutput(registry());
    capture.push("stdout", Buffer.from("a".repeat(30000)));
    capture.push("stderr", Buffer.from(KEY));
    const result = capture.snapshot();
    assert.equal(result.deliveryBlocked, "owned_key_detected");
    assert.equal(result.stdout + result.stderr, "");
  });

  it("blocks length-one values without a length exemption", () => {
    const capture = createBoundedProcessOutput(registry("q"));
    capture.push("stdout", Buffer.from("ordinary sequence"));
    assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
  });

  it("decodes split Unicode and preserves BOM and CRLF bytes", () => {
    const text = "\ufeff\u4e2d\u6587\ud83d\ude00\r\n";
    const bytes = Buffer.from(text);
    const capture = createBoundedProcessOutput(registry());
    for (const byte of bytes) capture.push("stdout", Buffer.from([byte]));
    capture.finish(true);
    const result = capture.snapshot();
    assert.equal(result.stdout, text);
    assert.equal(result.rawBytes, bytes.length);
    assert.equal(result.captureComplete, true);
    assert.deepEqual(result.rawOutput?.stdout, bytes);
    assert.deepEqual(result.rawOutput?.stderr, Buffer.alloc(0));
  });

  it("blocks a Unicode value across decoder and guard boundaries", () => {
    const text = "KEY_\u4e2d\ud83d\ude00_END";
    const bytes = Buffer.from(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      const capture = createBoundedProcessOutput(registry(text));
      capture.push("stdout", bytes.subarray(0, cut));
      capture.push("stdout", bytes.subarray(cut));
      assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
    }
  });

  it("checks registered UTF-16 bytes even when they are also valid UTF-8", () => {
    for (const [value, encoding] of [
      ["\uadc2", "le"],
      ["\uc2ad", "be"],
    ] as const) {
      const raw = Buffer.from(value, "utf16le");
      if (encoding === "be") raw.swap16();
      assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(raw), "\u00ad");
      const keys: OwnedKeyRegistry = {
        keys: [
          ...registry(value).keys,
          {
            keyId: "binary",
            value: raw.toString("latin1"),
            state: "retired",
            revision: 1,
            byteEncoding: "latin1",
          },
        ],
      };
      for (const split of [1, 2]) {
        const capture = createBoundedProcessOutput(keys);
        capture.push("stdout", raw.subarray(0, split));
        capture.push("stdout", raw.subarray(split));
        capture.finish(true);
        assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
        assert.equal(capture.snapshot().stdout, "");
      }
    }
  });

  it("rechecks retained raw bytes when binary protection is registered late", () => {
    let keys: OwnedKeyRegistry["keys"] = [];
    const capture = createBoundedProcessOutput({
      get keys() {
        return keys;
      },
    });
    const bytes = Buffer.from("\uadc2", "utf16le");
    capture.push("stdout", bytes);
    keys = [
      {
        keyId: "binary",
        value: bytes.toString("latin1"),
        state: "retired",
        revision: 1,
        byteEncoding: "latin1",
      },
    ];
    assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
  });

  it("does not split surrogate pairs at the release boundary", () => {
    const capture = createBoundedProcessOutput(registry("ABCDE"));
    capture.push("stdout", Buffer.from("ok\ud83d\ude00xyz"));
    assert.equal(capture.snapshot().stdout, "ok");
    capture.finish(true);
    assert.equal(capture.snapshot().stdout, "ok\ud83d\ude00xyz");
  });

  it("keeps independent decoder and key-prefix state for each stream", () => {
    const capture = createBoundedProcessOutput(registry("ABCDE"));
    capture.push("stdout", Buffer.from("ABC"));
    capture.push("stderr", Buffer.from("DE"));
    capture.finish(true);
    assert.equal(capture.snapshot().stdout, "ABC");
    assert.equal(capture.snapshot().stderr, "DE");
    assert.equal(capture.snapshot().deliveryBlocked, null);
  });

  it("fails closed for invalid UTF-8 and an unfinished final code point", () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8])]) {
      const capture = createBoundedProcessOutput();
      capture.push("stdout", Buffer.from("safe"));
      capture.push("stderr", bytes);
      capture.finish(true);
      const result = capture.snapshot();
      assert.equal(result.deliveryBlocked, "guard_failure");
      assert.equal(result.stdout + result.stderr, "");
      assert.equal(result.captureComplete, false);
    }
  });

  it("withholds unfinished key and decoder prefixes on incomplete capture", () => {
    const capture = createBoundedProcessOutput(registry());
    capture.push("stdout", Buffer.from(KEY.slice(0, -1)));
    capture.push("stderr", Buffer.from([0xe4]));
    capture.finish(false);
    assert.equal(capture.snapshot().stdout + capture.snapshot().stderr, "");
    assert.equal(capture.snapshot().captureComplete, false);
    assert.equal(capture.snapshot().rawOutput, undefined);
  });

  it("rechecks buffered data on rotation and retains removed values", () => {
    let keys: OwnedKeyRegistry["keys"] = [];
    const live = {
      get keys() {
        return keys;
      },
    };
    const capture = createBoundedProcessOutput(live);
    capture.push("stdout", Buffer.from(KEY.slice(0, 10)));
    keys = registry().keys;
    assert.equal(capture.snapshot().stdout, "");
    keys = [];
    capture.push("stdout", Buffer.from(KEY.slice(10)));
    assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
  });

  it("rechecks completed output when protection changes", () => {
    let keys: OwnedKeyRegistry["keys"] = [];
    const capture = createBoundedProcessOutput({
      get keys() {
        return keys;
      },
    });
    capture.push("stdout", Buffer.from(KEY));
    capture.finish(true);
    keys = registry().keys;
    assert.equal(capture.snapshot().deliveryBlocked, "owned_key_detected");
  });

  it("fails closed when protection cannot be read", () => {
    let failed = false;
    const capture = createBoundedProcessOutput({
      get keys() {
        if (failed) throw new Error("synthetic_protection_unavailable");
        return registry().keys;
      },
    });
    capture.push("stdout", Buffer.from("benign"));
    failed = true;
    assert.equal(capture.snapshot().deliveryBlocked, "guard_failure");
    assert.equal(capture.snapshot().stdout, "");
  });
});
