export type ApprovalRequest = Readonly<{
  approvalId: string;
  toolCallId: string;
  toolName: string;
  safePreview: string;
}>;

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalGate {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}
