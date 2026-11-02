export interface IdentifierFactory {
  create(): string;
}

export interface DigestService {
  sha256Canonical(value: unknown): Promise<string>;
}
