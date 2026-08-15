import type { RootConfig, LegConfig } from "./schema.js";

/**
 * Pure decision logic for hot-reload: given the config the pipeline is
 * currently running with and a freshly-validated new config, decides what
 * actually needs to change. Deliberately separate from the process-
 * management side effects (src/pipeline.ts's `reconcile()`) so the "what to
 * do" decision is fully unit-testable without spawning anything real.
 *
 * Conservative by design: ANY change to `renditions` (even to a rendition
 * no enabled leg currently references) forces a full combined-process
 * rebuild, rather than trying to determine whether the change is actually
 * observable in the running process. Correctness over minimal disruption —
 * a real still-life combined-process argv rebuild is cheap and safe; a
 * subtly-wrong "this rendition change doesn't matter" judgement is not.
 */
export interface ReconcilePlan {
  /** The combined decode/rendition-encode process ("relay") needs a full stop+rebuild+restart. */
  restartCombinedProcess: boolean;
  /** Human-readable reason, set whenever restartCombinedProcess is true — for logging. */
  restartCombinedReason?: string;
  /** Legs present in the new config but not the old — need a fresh supervised process. */
  legsToAdd: LegConfig[];
  /** Leg ids present in the old config but not the new — need their supervised process stopped and forgotten. */
  legsToRemove: string[];
  /** Legs present in both, but with different field values — need their supervised process stopped and rebuilt. */
  legsToRestart: LegConfig[];
  /** True if literally nothing actionable changed (e.g. a file save with no real content difference, or only restartPolicy changed — which only affects *future* restarts, nothing currently running). */
  noChanges: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function planReconciliation(oldConfig: RootConfig, newConfig: RootConfig): ReconcilePlan {
  const ingestChanged = !deepEqual(oldConfig.ingest, newConfig.ingest);
  const relayChanged = !deepEqual(oldConfig.relay, newConfig.relay);
  const encoderPriorityChanged = !deepEqual(oldConfig.encoderPriority, newConfig.encoderPriority);
  const renditionsChanged = !deepEqual(oldConfig.renditions, newConfig.renditions);
  const restartCombinedProcess = ingestChanged || relayChanged || encoderPriorityChanged || renditionsChanged;

  let restartCombinedReason: string | undefined;
  if (ingestChanged) restartCombinedReason = "ingest settings changed";
  else if (relayChanged) restartCombinedReason = "relay settings changed";
  else if (encoderPriorityChanged) restartCombinedReason = "encoderPriority changed";
  else if (renditionsChanged) restartCombinedReason = "renditions changed";

  const oldLegsById = new Map(oldConfig.legs.map((leg) => [leg.id, leg]));
  const newLegsById = new Map(newConfig.legs.map((leg) => [leg.id, leg]));

  const legsToAdd: LegConfig[] = [];
  const legsToRestart: LegConfig[] = [];
  for (const [id, newLeg] of newLegsById) {
    const oldLeg = oldLegsById.get(id);
    if (!oldLeg) {
      legsToAdd.push(newLeg);
    } else if (!deepEqual(oldLeg, newLeg)) {
      legsToRestart.push(newLeg);
    }
  }

  const legsToRemove: string[] = [];
  for (const id of oldLegsById.keys()) {
    if (!newLegsById.has(id)) legsToRemove.push(id);
  }

  const noChanges =
    !restartCombinedProcess &&
    legsToAdd.length === 0 &&
    legsToRestart.length === 0 &&
    legsToRemove.length === 0 &&
    deepEqual(oldConfig.restartPolicy, newConfig.restartPolicy);

  return { restartCombinedProcess, restartCombinedReason, legsToAdd, legsToRemove, legsToRestart, noChanges };
}
