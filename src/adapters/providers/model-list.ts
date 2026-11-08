import type { CatalogModel, ExplicitReasoningEffort } from "../../domain/config/model-catalog.ts";
import {
  protocolReasoningEfforts,
  type SupportedProtocol,
} from "../../domain/config/provider-config.ts";
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
  | Readonly<{ ok: true; models: readonly string[]; catalog?: readonly CatalogModel[] }>
  | Readonly<{ ok: false; code: string }>;

export type ModelListRequest = Readonly<{
  protocol: SupportedProtocol;
  baseUrl: string;
  apiKey: string;
  /** Injected for tests. */
  get?: (input: Omit<ProviderHttpRequest, "bodyText">) => Promise<ProviderHttpResult>;
  trustedCaPem?: string;
}>;

export type ModelDetailsResult =
  | Readonly<{ ok: true; model: CatalogModel }>
  | Readonly<{ ok: false; code: string }>;

/** Path that lists models, per protocol. */
export function modelListPath(protocol: SupportedProtocol): string {
  // Anthropic and both OpenAI protocols expose a model list at the same path. If a
  // protocol has no list endpoint, this must return null rather than invent one.
  if (protocol === "anthropic_messages") return "/v1/models";
  if (protocol === "openai_chat" || protocol === "openai_responses") return "/v1/models";
  return "/v1/models";
}

export async function fetchModelList(request: ModelListRequest): Promise<ModelListResult> {
  const result = await fetchModelResource(request, modelListPath(request.protocol));
  return result.ok ? parseModelList(result.bodyText, request.protocol) : result;
}

/** A bounded, read-only lookup for one selected model; never a generation probe. */
export async function fetchModelDetails(
  request: ModelListRequest & { model: string },
): Promise<ModelDetailsResult> {
  let encoded: string;
  try {
    if (
      request.model.trim().length === 0 ||
      request.model.length > 200 ||
      request.model === "." ||
      request.model === ".."
    )
      return { ok: false, code: "invalid_model" };
    encoded = encodeURIComponent(request.model);
  } catch {
    return { ok: false, code: "invalid_model" };
  }
  const result = await fetchModelResource(request, `${modelListPath(request.protocol)}/${encoded}`);
  if (!result.ok) return result;
  const parsed = parseModelDetails(result.bodyText, request.protocol);
  if (parsed.ok && parsed.model.id !== request.model) return { ok: false, code: "model_mismatch" };
  return parsed;
}

async function fetchModelResource(
  request: ModelListRequest,
  path: string,
): Promise<Readonly<{ ok: true; bodyText: string }> | Readonly<{ ok: false; code: string }>> {
  if (request.apiKey.length === 0) return { ok: false, code: "key_not_configured" };

  const get = request.get ?? providerHttpsGet;
  const base = request.baseUrl.replace(/\/+$/, "").replace(/\/v1(beta)?$/i, "");

  let posted: ProviderHttpResult;
  try {
    posted = await get({
      url: `${base}${path}`,
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

  return { ok: true, bodyText: posted.bodyText };
}

/**
 * Extract model identifiers from a list response.
 *
 * Both the Anthropic and OpenAI shapes carry an array of objects with an `id`; a
 * plain array of strings is also accepted because some gateways return that. Anything
 * else is rejected rather than coerced, so a wrong endpoint cannot look like an empty
 * catalogue.
 */
export function parseModelList(
  bodyText: string,
  protocol: SupportedProtocol = "openai_chat",
): ModelListResult {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok) return { ok: false, code: "body_not_json" };

  const value = parsed.value;
  const entries = extractEntries(value);
  if (entries === null) return { ok: false, code: "unexpected_shape" };

  const catalog = new Map<string, CatalogModel>();
  for (const entry of entries) {
    const id = modelIdOf(entry);
    if (id === null) continue;
    const metadata = reasoningMetadataOf(entry, protocol);
    const previous = catalog.get(id);
    // Conflicting duplicate declarations must not broaden selectable parameters.
    if (previous !== undefined) {
      if (
        JSON.stringify(previous.reasoning) !== JSON.stringify(metadata.reasoning) ||
        previous.reasoningInvalid !== metadata.reasoningInvalid
      )
        catalog.set(id, { id, reasoningInvalid: true });
      continue;
    }
    catalog.set(id, { id, ...metadata });
  }
  const models = [...catalog.keys()];
  // Deterministic order: a provider's ordering is not a promise.
  models.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const sorted = models.map((id) => catalog.get(id) as CatalogModel);
  return {
    ok: true,
    models,
    ...(sorted.some((entry) => entry.reasoning !== undefined || entry.reasoningInvalid)
      ? { catalog: sorted }
      : {}),
  };
}

export function parseModelDetails(
  bodyText: string,
  protocol: SupportedProtocol,
): ModelDetailsResult {
  const parsed = parseJsonBody(bodyText);
  if (!parsed.ok) return { ok: false, code: "body_not_json" };
  const entry =
    isRecord(parsed.value) && isRecord(parsed.value["data"]) ? parsed.value["data"] : parsed.value;
  const id = modelIdOf(entry);
  if (id === null) return { ok: false, code: "unexpected_shape" };
  return { ok: true, model: { id, ...reasoningMetadataOf(entry, protocol) } };
}

function reasoningMetadataOf(
  entry: unknown,
  protocol: SupportedProtocol,
): Pick<CatalogModel, "reasoning" | "reasoningInvalid"> {
  const reasoning = reasoningOf(entry, protocol);
  return reasoning === "invalid"
    ? { reasoningInvalid: true }
    : reasoning === undefined
      ? {}
      : { reasoning };
}

function reasoningOf(
  entry: unknown,
  protocol: SupportedProtocol,
): CatalogModel["reasoning"] | "invalid" {
  if (!isRecord(entry)) return undefined;
  const allowed = protocolReasoningEfforts(protocol);
  const reasoning = entry["reasoning"];
  const effort = entry["effort"];
  const declarations: unknown[] = [];
  // Optional gateway extension; not a field of the standard OpenAI model object.
  if ("supported_reasoning_efforts" in entry)
    declarations.push(entry["supported_reasoning_efforts"]);
  // OpenRouter's model catalog explicitly lists efforts; null means unrestricted.
  if (isRecord(reasoning) && "supported_efforts" in reasoning)
    declarations.push(
      reasoning["supported_efforts"] === null
        ? allowed.filter((effort) => effort !== "default")
        : reasoning["supported_efforts"],
    );
  // DeepSeek and compatible gateways expose this on both list and detail records.
  if (isRecord(effort) && "supported_levels" in effort)
    declarations.push(effort["supported_levels"]);
  if (protocol === "anthropic_messages") {
    const capabilities = entry["capabilities"];
    const capability = isRecord(capabilities) ? capabilities["effort"] : undefined;
    if (isRecord(capabilities) && "effort" in capabilities && !isRecord(capability))
      return "invalid";
    if (isRecord(capability)) {
      if (capability["supported"] === false) declarations.push([]);
      else if (capability["supported"] === true) {
        const levels: string[] = [];
        let observed = false;
        for (const level of allowed.filter((value) => value !== "default")) {
          const flag = capability[level];
          if (flag === undefined) continue;
          if (!isRecord(flag) || typeof flag["supported"] !== "boolean") return "invalid";
          observed = true;
          if (flag["supported"]) levels.push(level);
        }
        if (observed) declarations.push(levels);
      } else return "invalid";
    }
  }
  if (declarations.length === 0) return undefined;
  let selected: readonly ExplicitReasoningEffort[] | undefined;
  for (const declaration of declarations) {
    if (!Array.isArray(declaration) || declaration.some((value) => typeof value !== "string"))
      return "invalid";
    const efforts = allowed.filter(
      (effort): effort is ExplicitReasoningEffort =>
        effort !== "default" && declaration.includes(effort),
    );
    if (selected !== undefined && JSON.stringify(selected) !== JSON.stringify(efforts))
      return "invalid";
    selected = efforts;
  }
  const defaultLevel = isRecord(effort) ? effort["default_level"] : undefined;
  return selected === undefined
    ? undefined
    : {
        efforts: selected,
        ...(typeof defaultLevel === "string" &&
        selected.includes(defaultLevel as ExplicitReasoningEffort)
          ? { defaultEffort: defaultLevel as ExplicitReasoningEffort }
          : {}),
      };
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
