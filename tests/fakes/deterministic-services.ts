import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
} from "../../src/ports/approval-gate.ts";
import type { DigestService, IdentifierFactory } from "../../src/ports/identity.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../src/ports/tool-executor.ts";

export class SequenceIds implements IdentifierFactory {
  #next = 1;
  readonly #prefix: string;

  constructor(prefix = "id") {
    this.#prefix = prefix;
  }

  create(): string {
    const id = `${this.#prefix}-${this.#next}`;
    this.#next += 1;
    return id;
  }
}

export class JsonDigest implements DigestService {
  async sha256Canonical(value: unknown): Promise<string> {
    const text = JSON.stringify(value);
    let hash = 2_166_136_261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return `synthetic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
}

export class ScriptedProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ProviderCompletion[];

  constructor(responses: readonly ProviderCompletion[]) {
    this.#responses = [...responses];
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      return { kind: "invalid_response", safeCode: "script_exhausted" };
    }
    return response;
  }
}

export class RecordingTools implements ToolExecutor {
  readonly executions: ToolExecutionRequest[] = [];
  readonly #definitions: ReadonlyMap<string, ToolDefinition>;
  readonly #result: ToolExecutionResult;

  constructor(requiresApproval: boolean, result: ToolExecutionResult) {
    this.#definitions = new Map([
      [
        "write_note",
        {
          name: "write_note",
          version: "1",
          sideEffectClass: "filesystem_mutation",
          requiresApproval,
          concurrencySafe: false,
        },
      ],
      [
        "ask_user",
        {
          name: "ask_user",
          version: "1",
          sideEffectClass: "read_only",
          requiresApproval: false,
          concurrencySafe: false,
        },
      ],
      [
        "todo",
        {
          name: "todo",
          version: "1",
          sideEffectClass: "read_only",
          requiresApproval: false,
          concurrencySafe: false,
        },
      ],
    ]);
    this.#result = result;
  }

  getDefinition(toolName: string): ToolDefinition | null {
    return this.#definitions.get(toolName) ?? null;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    this.executions.push(request);
    return this.#result;
  }
}

export class ScriptedApprovalGate implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  readonly #decisions: ApprovalDecision[];

  constructor(decisions: readonly ApprovalDecision[]) {
    this.#decisions = [...decisions];
  }

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return this.#decisions.shift() ?? "denied";
  }
}
