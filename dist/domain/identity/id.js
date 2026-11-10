const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
export function parseEntityId(value) {
    if (!ID_PATTERN.test(value)) {
        throw new TypeError("entity id must be 1-128 printable ASCII characters without spaces");
    }
    return value;
}
