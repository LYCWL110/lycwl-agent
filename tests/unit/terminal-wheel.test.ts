import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMouseDecoder, createWheelDecoder } from "../../src/tui/terminal-wheel.ts";

describe("terminal wheel decoding", () => {
  it("decodes only primary presses as clicks and ignores releases, drags, modifiers and paste", () => {
    const decode = createMouseDecoder();
    assert.deepEqual(decode("\u001b[<0;8;3M\u001b[<0;8;3m\u001b[<32;8;3M\u001b[<4;8;3M"), [
      { column: 8, row: 3 },
    ]);
    assert.deepEqual(decode("\u001b[200~\u001b[<0;8;3M\u001b[201~"), []);
    assert.deepEqual([..."\u001b[<0;10;4M"].flatMap(decode), [{ column: 10, row: 4 }]);
  });
  it("handles multiple reports and modifiers without turning clicks into scrolling", () => {
    const decode = createWheelDecoder();
    assert.deepEqual(decode("\u001b[<64;12;5M\u001b[<65;12;6M\u001b[<68;12;7M\u001b[<0;12;5M"), [
      { direction: "up", column: 12, row: 5 },
      { direction: "down", column: 12, row: 6 },
      { direction: "up", column: 12, row: 7 },
    ]);
    assert.deepEqual(decode("\u001b[<64;12;5m\u001b[<96;12;5M\u001b[<66;12;5M"), []);
  });

  it("reassembles reports split between stdin chunks", () => {
    const decode = createWheelDecoder();
    const report = "\u001b[<64;80;24M";
    const events = [...report].flatMap((character) => decode(character));
    assert.deepEqual(events, [{ direction: "up", column: 80, row: 24 }]);
  });

  it("ignores pasted reports, including split paste markers", () => {
    const decode = createWheelDecoder();
    assert.deepEqual(decode("\u001b[20"), []);
    assert.deepEqual(decode("0~text\u001b[<64;12;5M\u001b[201"), []);
    assert.deepEqual(decode("~\u001b[<65;12;5M"), [{ direction: "down", column: 12, row: 5 }]);
  });

  it("recovers from malformed, oversized and unrelated control sequences", () => {
    const decode = createWheelDecoder();
    assert.deepEqual(
      decode(`plain text\u001b[5~\u001b[<${"9".repeat(5000)};1;1M\u001b[<64;0;1M\u001b[<64;1;0M`),
      [],
    );
    assert.deepEqual(decode("\u001b[<64;2;3M"), [{ direction: "up", column: 2, row: 3 }]);
  });
});
