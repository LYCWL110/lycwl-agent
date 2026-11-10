import type { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { selectRuntime as select } from "../../src/bootstrap/runtime-selection.ts";
import { ProtectedDeliveryError } from "../../src/services/security/guarded-delivery.ts";

const owners = new Set<RuntimeCoordinator>();

export async function selectRuntime(options: Parameters<typeof select>[0]) {
  const runtime = await select(options);
  if (runtime.kind === "real") owners.add(runtime.coordinator);
  return runtime;
}

export async function closeRuntimeSelections(): Promise<void> {
  try {
    for (const coordinator of owners) {
      try {
        await coordinator.closeSession("test-fixture-close");
      } catch (error) {
        // Some security fixtures deliberately make the protective vault unreadable.
        if (!(error instanceof ProtectedDeliveryError)) throw error;
      }
    }
  } finally {
    owners.clear();
  }
}
