import {
  pathInTraceScopes,
  type TraceRef,
} from "./scope-model.js";

/** Minimal file state needed to discover a newly-published replay head. */
interface ReplayHeadState {
  nodeId?: string;
}

/**
 * Find file heads that are both novel and inside the replay selection.
 * The selection check belongs here, at discovery time: a trace can Step while
 * the scrubber is selected elsewhere, and that unrelated Step
 * must not move the scrubber's current/total position.
 */
export function freshSelectedReplayHeads(
  files: Readonly<Record<string, ReplayHeadState>>,
  knownIds: ReadonlySet<string>,
  scopes: readonly TraceRef[],
  shielded: ReadonlySet<string>,
): Array<{ path: string; nodeId: string }> {
  const fresh: Array<{ path: string; nodeId: string }> = [];
  for (const [path, state] of Object.entries(files)) {
    const nodeId = state.nodeId;
    if (
      nodeId &&
      !knownIds.has(nodeId) &&
      pathInTraceScopes(scopes, shielded, path)
    ) {
      fresh.push({ path, nodeId });
    }
  }
  return fresh;
}

/**
 * Stable signal for structural replay refreshes. Any path or head change is
 * meaningful, including same-length node-id replacement and removal. The old
 * growth heuristic missed both of those cases.
 */
export function replayHeadSignature(
  files: Readonly<Record<string, ReplayHeadState>>,
): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, state]) => `${path}\u0000${state.nodeId ?? ""}`)
    .join("\u001f");
}

/**
 * Append novel steps only while the cursor is parked at the live end. Moving
 * from N/N to N+K/N+K in one state transition keeps the counter and slider in
 * sync; a user inspecting history stays parked and is never yanked forward.
 */
export function appendReplayStepsAtLiveEnd<
  T,
  S extends { steps: T[]; index: number },
>(
  state: S,
  candidates: readonly T[],
  keyOf: (step: T) => string,
  timeOf: (step: T) => number,
): S {
  if (state.steps.length === 0 || state.index !== state.steps.length - 1) {
    return state;
  }
  const seen = new Set(state.steps.map(keyOf));
  const fresh = candidates.filter((step) => {
    const key = keyOf(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (fresh.length === 0) return state;

  const steps = [...state.steps, ...fresh];
  steps.sort((a, b) => timeOf(a) - timeOf(b));
  return { ...state, steps, index: steps.length - 1 };
}
