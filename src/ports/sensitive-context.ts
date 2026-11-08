export type SensitiveSource = Readonly<{
  sourceId: string;
  label: string;
  contentDigest: string;
  origin: Readonly<{
    providerId: string;
    modelId: string;
    protocolId: string;
    endpointFingerprint: string;
    credentialRef: string;
    credentialRevision: number;
  }> | null;
}>;
