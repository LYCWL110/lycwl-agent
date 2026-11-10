import { protocolReasoningEfforts, } from "../../domain/config/provider-config.js";
import { providerHttpsGet, } from "./provider-http.js";
import { classifyHttpStatus, isRecord, parseJsonBody, transportFailure, } from "./provider-response.js";
/** Path that lists models, per protocol. */
export function modelListPath(protocol) {
    // Anthropic and both OpenAI protocols expose a model list at the same path. If a
    // protocol has no list endpoint, this must return null rather than invent one.
    if (protocol === "anthropic_messages")
        return "/v1/models";
    if (protocol === "openai_chat" || protocol === "openai_responses")
        return "/v1/models";
    return "/v1/models";
}
export async function fetchModelList(request) {
    const result = await fetchModelResource(request, modelListPath(request.protocol));
    return result.ok ? parseModelList(result.bodyText, request.protocol) : result;
}
/** A bounded, read-only lookup for one selected model; never a generation probe. */
export async function fetchModelDetails(request) {
    let encoded;
    try {
        if (request.model.trim().length === 0 ||
            request.model.length > 200 ||
            request.model === "." ||
            request.model === "..")
            return { ok: false, code: "invalid_model" };
        encoded = encodeURIComponent(request.model);
    }
    catch {
        return { ok: false, code: "invalid_model" };
    }
    const result = await fetchModelResource(request, `${modelListPath(request.protocol)}/${encoded}`);
    if (!result.ok)
        return result;
    const parsed = parseModelDetails(result.bodyText, request.protocol);
    if (parsed.ok && parsed.model.id !== request.model)
        return { ok: false, code: "model_mismatch" };
    return parsed;
}
async function fetchModelResource(request, path) {
    if (request.apiKey.length === 0)
        return { ok: false, code: "key_not_configured" };
    const get = request.get ?? providerHttpsGet;
    const base = request.baseUrl.replace(/\/+$/, "").replace(/\/v1(beta)?$/i, "");
    let posted;
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
    }
    catch {
        return { ok: false, code: "fetch_failed" };
    }
    if (!posted.ok) {
        const outcome = transportFailure(posted.code);
        return { ok: false, code: outcome.kind === "completed" ? "fetch_failed" : outcome.safeCode };
    }
    // A 404 means the endpoint does not offer a list; that is a normal outcome, not an
    // error worth alarming the user about.
    if (posted.status === 404)
        return { ok: false, code: "not_supported" };
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
export function parseModelList(bodyText, protocol = "openai_chat") {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok)
        return { ok: false, code: "body_not_json" };
    const value = parsed.value;
    const entries = extractEntries(value);
    if (entries === null)
        return { ok: false, code: "unexpected_shape" };
    const catalog = new Map();
    for (const entry of entries) {
        const id = modelIdOf(entry);
        if (id === null)
            continue;
        const metadata = reasoningMetadataOf(entry, protocol);
        const previous = catalog.get(id);
        // Conflicting duplicate declarations must not broaden selectable parameters.
        if (previous !== undefined) {
            if (JSON.stringify(previous.reasoning) !== JSON.stringify(metadata.reasoning) ||
                previous.reasoningInvalid !== metadata.reasoningInvalid)
                catalog.set(id, { id, reasoningInvalid: true });
            continue;
        }
        catalog.set(id, { id, ...metadata });
    }
    const models = [...catalog.keys()];
    // Deterministic order: a provider's ordering is not a promise.
    models.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const sorted = models.map((id) => catalog.get(id));
    return {
        ok: true,
        models,
        ...(sorted.some((entry) => entry.reasoning !== undefined || entry.reasoningInvalid)
            ? { catalog: sorted }
            : {}),
    };
}
export function parseModelDetails(bodyText, protocol) {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok)
        return { ok: false, code: "body_not_json" };
    const entry = isRecord(parsed.value) && isRecord(parsed.value["data"]) ? parsed.value["data"] : parsed.value;
    const id = modelIdOf(entry);
    if (id === null)
        return { ok: false, code: "unexpected_shape" };
    return { ok: true, model: { id, ...reasoningMetadataOf(entry, protocol) } };
}
function reasoningMetadataOf(entry, protocol) {
    const reasoning = reasoningOf(entry, protocol);
    return reasoning === "invalid"
        ? { reasoningInvalid: true }
        : reasoning === undefined
            ? {}
            : { reasoning };
}
function reasoningOf(entry, protocol) {
    if (!isRecord(entry))
        return undefined;
    const allowed = protocolReasoningEfforts(protocol);
    const reasoning = entry["reasoning"];
    const effort = entry["effort"];
    const declarations = [];
    // Optional gateway extension; not a field of the standard OpenAI model object.
    if ("supported_reasoning_efforts" in entry)
        declarations.push(entry["supported_reasoning_efforts"]);
    // OpenRouter's model catalog explicitly lists efforts; null means unrestricted.
    if (isRecord(reasoning) && "supported_efforts" in reasoning)
        declarations.push(reasoning["supported_efforts"] === null
            ? allowed.filter((effort) => effort !== "default")
            : reasoning["supported_efforts"]);
    // DeepSeek and compatible gateways expose this on both list and detail records.
    if (isRecord(effort) && "supported_levels" in effort)
        declarations.push(effort["supported_levels"]);
    if (protocol === "anthropic_messages") {
        const capabilities = entry["capabilities"];
        const capability = isRecord(capabilities) ? capabilities["effort"] : undefined;
        if (isRecord(capabilities) && "effort" in capabilities && !isRecord(capability))
            return "invalid";
        if (isRecord(capability)) {
            if (capability["supported"] === false)
                declarations.push([]);
            else if (capability["supported"] === true) {
                const levels = [];
                let observed = false;
                for (const level of allowed.filter((value) => value !== "default")) {
                    const flag = capability[level];
                    if (flag === undefined)
                        continue;
                    if (!isRecord(flag) || typeof flag["supported"] !== "boolean")
                        return "invalid";
                    observed = true;
                    if (flag["supported"])
                        levels.push(level);
                }
                if (observed)
                    declarations.push(levels);
            }
            else
                return "invalid";
        }
    }
    if (declarations.length === 0)
        return undefined;
    let selected;
    for (const declaration of declarations) {
        if (!Array.isArray(declaration) || declaration.some((value) => typeof value !== "string"))
            return "invalid";
        const efforts = allowed.filter((effort) => effort !== "default" && declaration.includes(effort));
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
                selected.includes(defaultLevel)
                ? { defaultEffort: defaultLevel }
                : {}),
        };
}
function extractEntries(value) {
    if (Array.isArray(value))
        return value;
    if (!isRecord(value))
        return null;
    const data = value["data"];
    if (Array.isArray(data))
        return data;
    const models = value["models"];
    if (Array.isArray(models))
        return models;
    return null;
}
function modelIdOf(entry) {
    if (typeof entry === "string")
        return entry.length === 0 ? null : entry;
    if (!isRecord(entry))
        return null;
    const id = entry["id"];
    if (typeof id === "string" && id.length > 0)
        return id;
    const name = entry["name"];
    if (typeof name === "string" && name.length > 0)
        return name;
    return null;
}
