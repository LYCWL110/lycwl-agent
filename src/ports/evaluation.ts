import type { EvaluationCaseId } from "../domain/evaluation/labels.ts";
import type { AssertionOutcome } from "../domain/evaluation/sample-record.ts";
import type { InternalEvent } from "./event-log.ts";

/**
 * Ports for the evaluation orchestrator (V1_EVALUATION_AND_RELEASE.md section 4).
 *
 * The orchestrator drives a sample but does not know how to copy a fixture, run a
 * verifier or launch the agent. Those are injected so the same orchestration can be
 * exercised with a deterministic stand-in and later with the real filesystem and
 * the real coordinator.
 *
 * A provisioned workspace is disposable by construction: section 4 requires every
 * sample to start from the frozen initial state in a fresh isolated directory, so
 * the port has no way to express "reuse the previous sample's workspace".
 */

export type ProvisionedWorkspace = Readonly<{
  /** Absolute path to the isolated copy. */
  root: string;
  /**
   * sha256 of a workspace-relative file, or null when it does not exist.
   *
   * The runner uses this for the immutable-file check: a fix that edits the
   * verifier or an unrelated package fails the process check even when the code is
   * correct.
   */
  hashFile: (relativePath: string) => Promise<string | null>;
  /** Remove only this copy. Never touches the frozen fixture or user data. */
  dispose: () => Promise<void>;
}>;

export interface CaseWorkspaceProvider {
  provision(input: Readonly<{ caseId: EvaluationCaseId }>): Promise<ProvisionedWorkspace>;
}

export type VerifierOutcome = Readonly<{
  assertions: readonly AssertionOutcome[];
  /**
   * Set when the verifier itself could not run, for example because the fixture
   * hash no longer matches its manifest. The sample becomes `invalid_fixture`,
   * which is recorded rather than dropped.
   */
  invalidReason?: string;
}>;

export interface CaseVerifier {
  verify(
    input: Readonly<{ caseId: EvaluationCaseId; workspaceRoot: string }>,
  ): Promise<VerifierOutcome>;
}

export type AgentRunRequest = Readonly<{
  caseId: EvaluationCaseId;
  workspaceRoot: string;
  /** The task text the case defines. */
  task: string;
}>;

export type AgentRunOutcome = Readonly<{
  /** Session and Run identities this sample used. Never reused across samples. */
  runIdentities: readonly string[];
  status: "completed" | "failed" | "cancelled" | "waiting";
  safeCode: string | null;
  /** Authoritative events, so the runner can scan for violations and claims. */
  events: readonly InternalEvent[];
}>;

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}
