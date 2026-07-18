import { contentFingerprint, type ContextSnapshot } from "./context-snapshot.js";

export interface SnapshotDependencies {
  focus: string;
  targetRevision: string;
  mount: string;
  shields: readonly string[];
  providerFingerprint: string;
  modelVoicePromptHash: string;
  lensId: string;
  operation: string;
  operationInputsHash: string;
  /** Current-session editor authority can change prompt instruction bytes. */
  authoringAuthorityHash?: string;
  /** Signed selector material/policy changes invalidate cached approval input. */
  traceContextBoundaryHash?: string;
  promptLayerVersions: readonly string[];
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}

export function snapshotDependencyKey(dependencies: SnapshotDependencies): string {
  return contentFingerprint(stable({
    ...dependencies,
    shields: [...dependencies.shields].sort(),
    promptLayerVersions: [...dependencies.promptLayerVersions],
  }));
}

/** Share one exact gather between estimate, Inspector, and preparation. A
 * dependency change aborts superseded work and invalidates approval/cache. */
export class SnapshotCoordinator {
  private currentKey: string | null = null;
  private completed: { key: string; snapshot: ContextSnapshot } | null = null;
  private inFlight: {
    key: string;
    controller: AbortController;
    promise: Promise<ContextSnapshot>;
  } | null = null;

  request(
    dependencies: SnapshotDependencies,
    gather: (signal: AbortSignal) => Promise<ContextSnapshot>,
    signal?: AbortSignal,
  ): Promise<ContextSnapshot> {
    const key = snapshotDependencyKey(dependencies);
    if (this.currentKey !== key) {
      this.invalidate();
      this.currentKey = key;
    }
    if (this.completed?.key === key) return Promise.resolve(this.completed.snapshot);
    if (this.inFlight?.key === key) return this.inFlight.promise;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });

    const promise = gather(controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) throw abortError();
        if (this.currentKey === key && snapshot.completeness.complete) {
          this.completed = { key, snapshot };
        }
        return snapshot;
      })
      .finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (this.inFlight?.key === key) this.inFlight = null;
      });
    this.inFlight = { key, controller, promise };
    return promise;
  }

  invalidate(): void {
    this.inFlight?.controller.abort("snapshot dependencies changed");
    this.inFlight = null;
    this.completed = null;
    this.currentKey = null;
  }

  peek(dependencies: SnapshotDependencies): ContextSnapshot | null {
    const key = snapshotDependencyKey(dependencies);
    return this.completed?.key === key ? this.completed.snapshot : null;
  }
}

function abortError(): Error {
  const error = new Error("Context gather was cancelled");
  error.name = "AbortError";
  return error;
}
