/**
 * Typed non-Shell process environment configuration (C09 / ADR-0006).
 *
 * Each concrete non-Shell process configuration (for example an LSP server)
 * owns its own environment settings. Sources are typed: an ordinary literal, a
 * same-name parent variable, or a dedicated tool-secret reference. Selecting a
 * source never disables filtering by itself; a filtered name needs its own
 * explicit `allowFiltered` authorization.
 */
export const ENV_LIMITS = Object.freeze({
    maxEntries: 64,
    maxNameLength: 256,
    maxLiteralLength: 8_192,
});
export function createEnvConfiguration(configurationId) {
    return {
        configurationId,
        set: [],
        unset: [],
        allowFiltered: [],
        revision: 0,
    };
}
/**
 * Windows environment names are case-insensitive. Within one configuration layer
 * `PATH` and `Path` are the same name, which is a duplicate error rather than a
 * silent overwrite.
 */
function canonicalName(name) {
    return name.toUpperCase();
}
function validateName(name) {
    if (name.length === 0 || name.length > ENV_LIMITS.maxNameLength)
        return "invalid_name";
    if (name.includes("="))
        return "invalid_name";
    for (const character of name) {
        const code = character.codePointAt(0);
        if (code === undefined || code < 0x20 || code === 0x7f)
            return "invalid_name";
    }
    return null;
}
export function setVariable(config, name, source) {
    const nameFailure = validateName(name);
    if (nameFailure !== null)
        return { ok: false, code: nameFailure };
    if (config.set.length >= ENV_LIMITS.maxEntries) {
        return { ok: false, code: "too_many_entries" };
    }
    const canonical = canonicalName(name);
    if (config.set.some((entry) => canonicalName(entry.name) === canonical)) {
        return { ok: false, code: "duplicate_name" };
    }
    if (config.unset.some((entry) => canonicalName(entry) === canonical)) {
        return { ok: false, code: "set_unset_conflict" };
    }
    const sourceFailure = validateSource(source);
    if (sourceFailure !== null)
        return { ok: false, code: sourceFailure };
    return {
        ok: true,
        value: {
            ...config,
            set: [...config.set, { name, source }],
        },
    };
}
function validateSource(source) {
    if (source.kind === "literal") {
        if (source.value.length > ENV_LIMITS.maxLiteralLength)
            return "invalid_literal";
        return null;
    }
    if (source.kind === "parent") {
        return validateName(source.name) === null ? null : "invalid_name";
    }
    if (source.reference.length === 0)
        return "invalid_reference";
    return null;
}
export function unsetVariable(config, name) {
    const nameFailure = validateName(name);
    if (nameFailure !== null)
        return { ok: false, code: nameFailure };
    const canonical = canonicalName(name);
    if (config.set.some((entry) => canonicalName(entry.name) === canonical)) {
        return { ok: false, code: "set_unset_conflict" };
    }
    if (config.unset.some((entry) => canonicalName(entry) === canonical)) {
        // Unsetting an already unset name is idempotent, not an error.
        return { ok: true, value: config };
    }
    return { ok: true, value: { ...config, unset: [...config.unset, name] } };
}
/**
 * Authorize a filtered name for this configuration only. This is an exact name,
 * never a wildcard, and it does not by itself permit an owned Provider key.
 */
export function allowFilteredName(config, name) {
    const nameFailure = validateName(name);
    if (nameFailure !== null)
        return { ok: false, code: nameFailure };
    const canonical = canonicalName(name);
    if (config.allowFiltered.some((entry) => canonicalName(entry) === canonical)) {
        return { ok: true, value: config };
    }
    return { ok: true, value: { ...config, allowFiltered: [...config.allowFiltered, name] } };
}
/** Revision increases only after a successful save, never on a draft edit. */
export function commitConfiguration(config) {
    return { ...config, revision: config.revision + 1 };
}
/**
 * Resolve sources, merge with the inherited environment, apply unset, then apply
 * the shared filter with only this configuration's authorized exceptions. A
 * later overlay can never restore a filtered name.
 */
export async function resolveEnvironment(config, options) {
    const merged = new Map();
    for (const [name, value] of Object.entries(options.parent)) {
        merged.set(canonicalName(name), value);
    }
    const unresolvedNames = [];
    for (const entry of config.set) {
        const canonical = canonicalName(entry.name);
        if (entry.source.kind === "literal") {
            merged.set(canonical, entry.source.value);
            continue;
        }
        if (entry.source.kind === "parent") {
            const inherited = merged.get(canonicalName(entry.source.name));
            if (inherited === undefined) {
                unresolvedNames.push(entry.name);
                continue;
            }
            merged.set(canonical, inherited);
            continue;
        }
        const secret = await options.resolveToolSecret(entry.source.reference);
        if (secret === null) {
            unresolvedNames.push(entry.name);
            continue;
        }
        merged.set(canonical, secret);
    }
    for (const name of config.unset) {
        merged.delete(canonicalName(name));
    }
    const filtered = new Set(options.filteredNames.map(canonicalName));
    const authorized = new Set(config.allowFiltered.map(canonicalName));
    const environment = {};
    const filteredNames = [];
    for (const [canonical, value] of merged) {
        const base = canonical.startsWith("INPUT_") ? canonical.slice("INPUT_".length) : canonical;
        if ((filtered.has(canonical) || filtered.has(base)) && !authorized.has(canonical)) {
            filteredNames.push(canonical);
            continue;
        }
        environment[canonical] = value;
    }
    return {
        ok: true,
        value: {
            environment,
            filteredNames: filteredNames.sort(),
            unresolvedNames,
            revision: config.revision,
        },
    };
}
/**
 * Fingerprint an environment for precondition rechecks without exposing secret
 * values: names plus a salted digest of each value.
 */
export function fingerprintEnvironment(environment, digest) {
    const fingerprint = {};
    for (const name of Object.keys(environment).sort()) {
        fingerprint[name] = digest(`${name}=${environment[name] ?? ""}`);
    }
    return fingerprint;
}
