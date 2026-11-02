const ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

export type EntityId = string & { readonly __entityId: unique symbol };

export function parseEntityId(value: string): EntityId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError("entity id must be 1-128 printable ASCII characters without spaces");
  }
  return value as EntityId;
}
