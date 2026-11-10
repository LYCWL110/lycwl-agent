import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AnthropicProvider } from "../../src/adapters/providers/anthropic-provider.ts";
import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../../src/adapters/providers/openai-responses-provider.ts";

/**
 * Image serialization per protocol.
 *
 * Each protocol names an inline image differently. These assert the request body a
 * provider would actually receive, because a wrong shape is rejected at the network
 * boundary and would only surface as a failed Run.
 */

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

function capture() {
  const bodies: string[] = [];
  return {
    bodies,
    post: async (request: { bodyText: string }) => {
      bodies.push(request.bodyText);
      return {
        ok: true as const,
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ content: [], output: [], choices: [] }),
        wireBytes: 2,
      };
    },
  };
}

const conversation = [
  {
    kind: "user" as const,
    text: "what is this?",
    images: [{ mediaType: "image/png" as const, base64: PNG_BASE64 }],
  },
];

describe("Anthropic image serialization", () => {
  it("sends image blocks before the text", async () => {
    const recorder = capture();
    const provider = new AnthropicProvider({
      resolveApiKey: async () => "key",
      model: "m",
      endpoint: "https://example.invalid/v1/messages",
      post: recorder.post,
    });
    await provider.complete({ modelRequestId: "r", attemptNo: 1, conversation });
    const body = JSON.parse(recorder.bodies[0] ?? "{}");
    const content = body.messages[0].content;
    assert.equal(Array.isArray(content), true);
    assert.deepEqual(content[0], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
    });
    assert.deepEqual(content[1], { type: "text", text: "what is this?" });
  });

  it("keeps a text-only turn as a plain string", async () => {
    const recorder = capture();
    const provider = new AnthropicProvider({
      resolveApiKey: async () => "key",
      model: "m",
      endpoint: "https://example.invalid/v1/messages",
      post: recorder.post,
    });
    await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "no image" }],
    });
    const body = JSON.parse(recorder.bodies[0] ?? "{}");
    assert.equal(body.messages[0].content, "no image");
  });
});

describe("OpenAI Chat image serialization", () => {
  it("sends image_url parts with a data URL", async () => {
    const recorder = capture();
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: recorder.post,
    });
    await provider.complete({ modelRequestId: "r", attemptNo: 1, conversation });
    const body = JSON.parse(recorder.bodies[0] ?? "{}");
    const content = body.messages[0].content;
    assert.deepEqual(content[0], {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
    });
    assert.deepEqual(content[1], { type: "text", text: "what is this?" });
  });

  it("keeps a text-only turn as a plain string", async () => {
    const recorder = capture();
    const provider = new OpenAiChatProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: recorder.post,
    });
    await provider.complete({
      modelRequestId: "r",
      attemptNo: 1,
      conversation: [{ kind: "user", text: "no image" }],
    });
    const body = JSON.parse(recorder.bodies[0] ?? "{}");
    assert.equal(body.messages[0].content, "no image");
  });
});

describe("OpenAI Responses image serialization", () => {
  it("sends input_image parts with a data URL", async () => {
    const recorder = capture();
    const provider = new OpenAiResponsesProvider({
      resolveApiKey: async () => "key",
      model: "m",
      baseUrl: "https://example.invalid",
      post: recorder.post,
    });
    await provider.complete({ modelRequestId: "r", attemptNo: 1, conversation });
    const body = JSON.parse(recorder.bodies[0] ?? "{}");
    const content = body.input[0].content;
    assert.deepEqual(content[0], {
      type: "input_image",
      image_url: `data:image/png;base64,${PNG_BASE64}`,
    });
    assert.deepEqual(content[1], { type: "input_text", text: "what is this?" });
  });
});
