/**
 * Credential boundary (C10 / ADR-0002 / ADR-0023).
 *
 * Secrets live only in Windows Credential Manager. Configuration, events, logs,
 * attachments and previews carry a reference and a revision, never a value.
 *
 * The purpose field is enforced here, not inferred from a name prefix: a search
 * credential cannot be borrowed to authenticate a model Provider, and vice
 * versa. Validating the purpose is what stops a reference from silently gaining
 * authority it was never granted.
 */
export const CREDENTIAL_LIMITS = Object.freeze({
    maxReferenceLength: 128,
    maxSecretBytes: 4_096,
});
/** Reference names are app-scoped and printable; they are not secrets. */
export function validateReference(reference) {
    if (reference.length === 0)
        return "invalid_reference";
    if (reference.length > CREDENTIAL_LIMITS.maxReferenceLength)
        return "invalid_reference";
    for (const character of reference) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
            return "invalid_reference";
        }
    }
    return null;
}
