import type { SupportedProtocol } from "../../domain/config/provider-config.ts";
import {
  type ProviderHttpFailure,
  type ProviderHttpRequest,
  type ProviderHttpResult,
  providerHttpsGet,
} from "./provider-http.ts";
import {
  classifyHttpStatus,
  isRecord,
  parseJsonBody,
  transportFailure,
} from "./provider-response.ts";

/**
 * Fetch the model list a provider offers.
 *
 * This is a configuration convenience, not a Run capability: it tells the user what
 * they can type, and nothing here changes the route of a Run. A failure is reported
 * and the browser stays usable with a hand-typed name, because a configuration
 * screen must not become unreachable when the network is down.
 *
 * The response shapes differ per protocol, so each one is parsed explicitly rather
 * than by guessing at a common envelope.
 */

export type ModelListResult =
  | Readonly<{ ok: true; models: readonly string[] }>
  | Readonly<{ ok: false; code: string }>;

export type ModelListRequest = Readonly<{
  protocol: SupportedProtocol;
  baseUrl: string;
  apiKey: string;
  /** Injected for tests. */
  get?: (input: Omit<ProviderHttpRequest, "bodyText">) => Promise<ProviderHttpResult>;
  trustedCaPem?: string;
}>;

/** Path that lists models, per protocol. */
export function modelListPath(protocol: SupportedProtocol): string {
  // Anthropic and both OpenAI protocols expose a model list at the same path. If a
  // protocol has no list endpoint, this must return null rather than invent one.
  if (protocol === "anthropic_messages") return "/v1/models";
  if (protocol === "openai_chat" || protocol === "openai_responses") return "/v1/models";
  return "/v1/models";
}

export async function fetchModelList(request: ModelListRequest): Promise<ModelListResult> {
  if (request.apiKey.length === 0) return { ok: false, code: "key_not_configured" };

  const get = request.get ?? providerHttpsGet;
  const base = request.baseUrl.replace(/\/+$/, "");

  let posted: ProviderHttpResult;
  try {
    posted = await get({
      url: `${base}${modelListPath(request.protocol)}`,
      headers: {
        accept: "application/json",
        ...(request.protocol === "anthropic_messages"
          ? { "x-api-key": request.apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${request.apiKey}` }),
      },
      ...(request.trustedCaPem === undefined ? {} : { trustedCaPem: request.trustedCaPem }),
    });
  } catch {
    return { ok: false, code: "fetch_failed" };
  }

  if (!posted.ok) {
    const outcome = transportFailure(posted.code as ProviderHttpFailure);
    return { ok: false, code: outcome.kind === "completed" ? "fetch_failed" : outcome.safeCode };
  }

  // A 404 means the endpoint does not offer a list; that is a normal outcome, not an
  // error worth alarming the user about.
  if (posted.status === 404) return { ok: false, code: "not_supported" };

  const statusOutcome = classifyHttpStatus(posted.status, posted.headers, "model_list");
  if (statusOutcome !== null) {
    return {
      ok: false,
      code: statusOutcome.kind === "completed" ? "fetch_failed" : statusOutcome.safeCode,
    };
  }

  return parseModelList(posted.bodyText);
}

/**
 * Extract model identifiers from a list response.
 *
 * Both the Anthropic and OpenAI shapes carry an array of objects with an `id`; a
 * plain array of strings is also accepted because some gateways return that. Anything
 * else is rejected rather than coerced, so a wrong endpoint cannot look like an empty
 * catalogue.
 */
export function parseModelList(bodyText: string): ModelListResult {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok) return { ok: false, code: "body_not_json" };

  const value = parsed.value;
  const entries = extractEntries(value);
  if (entries === null) return { ok: false, code: "unexpected_shape" };

  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = modelIdOf(entry);
    if (id === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  // Deterministic order: a provider's ordering is not a promise.
  models.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { ok: true, models };
}

function extractEntries(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  const data = value["data"];
  if (Array.isArray(data)) return data;
  const models = value["models"];
  if (Array.isArray(models)) return models;
  return null;
}

function modelIdOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry.length === 0 ? null : entry;
  if (!isRecord(entry)) return null;
  const id = entry["id"];
  if (typeof id === "string" && id.length > 0) return id;
  const name = entry["name"];
  if (typeof name === "string" && name.length > 0) return name;
  return null;
}
